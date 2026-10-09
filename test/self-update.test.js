'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const updater = require('../updater/update-service');
const selfUpdate = require('../src/self-update');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

// ---------- the updater, against real git and a pretend Docker ----------

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

// A GitHub stand-in (bare repo) and a server copy cloned from it.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-updater-'));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  const src = path.join(root, 'src');
  const data = path.join(root, 'data');
  fs.mkdirSync(work);
  fs.mkdirSync(data);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'docker-compose.yml'), 'name: roost\n');
  fs.writeFileSync(path.join(work, 'app.js'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'First version');
  git(root, 'clone', '-q', '--bare', work, origin);
  git(root, 'clone', '-q', origin, src);
  const publish = (file, text, message) => {
    fs.writeFileSync(path.join(work, file), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', origin, 'main');
  };
  return { root, work, origin, src, data, publish, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Pretend Docker: records what it was asked, and behaves as told.
function fakeDocker({ project = 'roost', buildFails = false, health = ['healthy'] } = {}) {
  const calls = [];
  const healths = [...health];
  const exec = async (cmd, args, opts) => {
    if (cmd === 'git') return updater.run(cmd, args, opts);
    calls.push(args.join(' '));
    const line = args.join(' ');
    if (line.includes('com.docker.compose.project')) return { code: 0, out: project };
    if (line.startsWith('inspect -f {{.Config.Image}} roost-backup')) return { code: 0, out: 'roost-roost-backup' };
    if (line.startsWith('inspect -f {{.Config.Image}} roost')) return { code: 0, out: 'roost-roost' };
    if (line.startsWith('image inspect')) return { code: 1, out: '' };
    if (line.includes('State.Health')) return { code: 0, out: healths.length > 1 ? healths.shift() : healths[0] };
    if (line.startsWith('logs')) return { code: 0, out: 'Error: Cannot find module\nat boot' };
    if (line.includes(' build ')) return buildFails ? { code: 1, out: 'step 4 failed' } : { code: 0, out: '' };
    return { code: 0, out: '' };
  };
  return { exec, calls };
}

const make = (w, docker) => updater.create({ dataDir: w.data, srcDir: w.src, exec: docker.exec, wait: async () => {}, healthWaitMs: 1000 });

test('check lists what is new on GitHub', async () => {
  const w = world();
  try {
    const u = make(w, fakeDocker());
    await u.check();
    assert.equal(u.status().behind, 0);
    assert.equal(u.status().head.subject, 'First version');
    w.publish('app.js', 'two\n', 'Second version');
    w.publish('docker-compose.yml', 'name: roost\n# more\n', 'Change the compose file');
    await u.check();
    const s = u.status();
    assert.equal(s.behind, 2);
    assert.deepEqual(s.commits.map((c) => c.subject), ['Change the compose file', 'Second version']);
    assert.equal(s.composeChanged, true);
    assert.equal(s.updaterChanged, false);
    // Looking never changes the code folder.
    assert.equal(fs.readFileSync(path.join(w.src, 'app.js'), 'utf8'), 'one\n');
    // And Roost can read what it wrote.
    const seen = selfUpdate.summarize(selfUpdate.readStatus(w.data));
    assert.equal(seen.state, 'available');
    assert.equal(seen.behind, 2);
  } finally { w.done(); }
});

test('an update builds, restarts, waits for health, and keeps the old image to go back to', async () => {
  const w = world();
  try {
    const d = fakeDocker();
    const u = make(w, d);
    w.publish('app.js', 'two\n', 'Second version');
    const from = git(w.src, 'rev-parse', 'HEAD');
    selfUpdate.writeRequest(w.data, 'apply');
    await u.tick();
    const s = u.status();
    assert.equal(s.last.ok, true);
    assert.equal(s.last.from, from);
    assert.equal(s.last.to, git(w.src, 'rev-parse', 'HEAD'));
    assert.equal(s.last.count, 1);
    assert.equal(s.state, 'idle');
    assert.equal(s.behind, 0);
    assert.equal(fs.readFileSync(path.join(w.src, 'app.js'), 'utf8'), 'two\n');
    const order = d.calls.filter((c) => /^tag |^compose/.test(c));
    assert.deepEqual(order, [
      'tag roost-roost roost-roost:previous',
      'tag roost-roost-backup roost-roost-backup:previous',
      'compose -p roost build roost roost-backup',
      'compose -p roost up -d --no-deps roost roost-backup',
    ]);
    // The request was taken, so it can't run twice.
    assert.equal(selfUpdate.hasRequest(w.data), false);
  } finally { w.done(); }
});

test('a version that will not build changes nothing', async () => {
  const w = world();
  try {
    const d = fakeDocker({ buildFails: true });
    const u = make(w, d);
    w.publish('app.js', 'two\n', 'Broken version');
    const before = git(w.src, 'rev-parse', 'HEAD');
    await u.apply();
    const last = u.status().last;
    assert.equal(last.ok, false);
    assert.match(last.error, /didn’t build|didn't build/);
    assert.match(last.detail, /step 4 failed/);
    assert.equal(last.rolledBack, true);
    assert.equal(git(w.src, 'rev-parse', 'HEAD'), before);
    assert.equal(fs.readFileSync(path.join(w.src, 'app.js'), 'utf8'), 'one\n');
    // It never restarted anything on the strength of a failed build.
    assert.equal(d.calls.some((c) => c.startsWith('compose -p roost up -d --no-deps roost roost-backup')), false);
    // GitHub still has the version, so it still shows as waiting.
    assert.equal(u.status().behind, 1);
  } finally { w.done(); }
});

test('a version that starts but is not healthy is rolled back', async () => {
  const w = world();
  try {
    // Unhealthy after the update, healthy again after going back.
    const d = fakeDocker({ health: ['unhealthy', 'healthy'] });
    const u = make(w, d);
    w.publish('app.js', 'two\n', 'Crashing version');
    const before = git(w.src, 'rev-parse', 'HEAD');
    await u.apply();
    const last = u.status().last;
    assert.equal(last.ok, false);
    assert.match(last.error, /didn’t start properly|didn't start properly/);
    assert.match(last.detail, /Cannot find module/);
    assert.equal(last.rolledBack, true);
    assert.equal(git(w.src, 'rev-parse', 'HEAD'), before);
    assert.ok(d.calls.includes('tag roost-roost:previous roost-roost:latest'));
    assert.ok(d.calls.includes('compose -p roost up -d --no-deps --no-build roost roost-backup'));
  } finally { w.done(); }
});

test('edits made on the server are kept, and only block an update that touches the same file', async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.src, 'docker-compose.yml'), 'name: roost\n# my drive folders\n');
    const d = fakeDocker();
    const u = make(w, d);
    // An update that leaves the compose file alone goes through, and the edit survives.
    w.publish('app.js', 'two\n', 'Second version');
    await u.apply();
    assert.equal(u.status().last.ok, true);
    assert.equal(fs.readFileSync(path.join(w.src, 'docker-compose.yml'), 'utf8'), 'name: roost\n# my drive folders\n');
    // One that changes the same file stops before touching anything.
    w.publish('docker-compose.yml', 'name: roost\n# theirs\n', 'Change the compose file');
    d.calls.length = 0;
    await u.apply();
    const last = u.status().last;
    assert.equal(last.ok, false);
    assert.match(last.error, /docker-compose\.yml/);
    assert.match(last.error, /override/);
    assert.deepEqual(u.status().conflicts, ['docker-compose.yml']);
    assert.equal(d.calls.some((c) => c.includes('build')), false);
    assert.equal(fs.readFileSync(path.join(w.src, 'docker-compose.yml'), 'utf8'), 'name: roost\n# my drive folders\n');
  } finally { w.done(); }
});

test('it refuses while a backup is running, or when Roost was started some other way', async () => {
  const w = world();
  try {
    w.publish('app.js', 'two\n', 'Second version');
    fs.writeFileSync(path.join(w.data, 'backup-status.json'), JSON.stringify({ running: true, updatedAt: new Date().toISOString() }));
    const d = fakeDocker();
    const u = make(w, d);
    await u.apply();
    assert.match(u.status().last.error, /backup is running/);
    fs.rmSync(path.join(w.data, 'backup-status.json'));

    const other = fakeDocker({ project: 'zimaos-roost' });
    const u2 = make(w, other);
    await u2.apply();
    assert.match(u2.status().last.error, /started some other way/);
    assert.equal(other.calls.some((c) => c.includes('build') || c.startsWith('tag')), false);
    assert.equal(git(w.src, 'rev-parse', 'HEAD'), git(w.src, 'rev-parse', 'HEAD~0'));
    assert.equal(fs.readFileSync(path.join(w.src, 'app.js'), 'utf8'), 'one\n');
  } finally { w.done(); }
});

test('GitHub being unreachable is reported, not guessed at', async () => {
  const w = world();
  try {
    git(w.src, 'remote', 'set-url', 'origin', path.join(w.root, 'nowhere.git'));
    const u = make(w, fakeDocker());
    await u.check();
    assert.match(u.status().checkError, /reach GitHub/);
    assert.equal(selfUpdate.summarize(selfUpdate.readStatus(w.data)).state, 'error');
  } finally { w.done(); }
});

test('only known requests are taken, and it checks by itself once at the start', async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.data, selfUpdate.REQUEST_FILE), JSON.stringify({ action: 'rm -rf /' }));
    assert.equal(updater.takeRequest(w.data), null);
    assert.equal(selfUpdate.hasRequest(w.data), false);
    let clock = Date.now();
    const d = fakeDocker();
    const u = updater.create({ dataDir: w.data, srcDir: w.src, exec: d.exec, now: () => clock, wait: async () => {} });
    await u.tick();
    assert.equal(u.status().checkedAt, undefined, 'waits a little after starting');
    clock += 31 * 1000;
    await u.tick();
    assert.ok(u.status().checkedAt);
  } finally { w.done(); }
});

// ---------- the Roost side ----------

let server;
let base;
let dataDir;
let adminCookie;
let userCookie;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-update-admin-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, adminCookie);
  await call('POST', '/api/admin/users', { username: 'sam', password: 'sam sam sam' }, adminCookie);
  userCookie = (await call('POST', '/api/login', { username: 'sam', password: 'sam sam sam' })).cookie;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

const admin = (method, url, body) => call(method, url, body, adminCookie);
const report = (extra = {}) => fs.writeFileSync(path.join(dataDir, selfUpdate.STATUS_FILE), JSON.stringify({
  updatedAt: new Date().toISOString(), state: 'idle', checkedAt: new Date().toISOString(),
  head: { sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-10-09T10:00:00Z', subject: 'x' },
  behind: 2, ahead: 0, conflicts: [], commits: [{ sha: 'bbbbbbb', subject: 'Second' }, { sha: 'ccccccc', subject: 'Third' }], ...extra,
}));
const clear = () => { fs.rmSync(path.join(dataDir, selfUpdate.REQUEST_FILE), { force: true }); };

test('only admins see or control updates', async () => {
  for (const [method, url] of [['GET', '/api/admin/update'], ['POST', '/api/admin/update/check'], ['POST', '/api/admin/update/apply']]) {
    assert.equal((await call(method, url, method === 'POST' ? { confirm: true } : undefined)).status, 401, url);
    assert.equal((await call(method, url, method === 'POST' ? { confirm: true } : undefined, userCookie)).status, 403, url);
  }
  assert.equal(selfUpdate.hasRequest(dataDir), false);
});

test('without the updater, the card says so and nothing is requested', async () => {
  assert.equal((await admin('GET', '/api/admin/update')).body.state, 'off');
  const check = await admin('POST', '/api/admin/update/check');
  assert.equal(check.status, 409);
  assert.match(check.body.error, /roost-updater/);
  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: true })).status, 409);
  // An updater that went quiet counts as stopped.
  report({ updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  assert.equal((await admin('GET', '/api/admin/update')).body.state, 'stopped');
  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: true })).status, 409);
  assert.equal(selfUpdate.hasRequest(dataDir), false);
});

test('Update needs the confirmation, and then leaves one request and a log entry', async () => {
  report();
  const seen = (await admin('GET', '/api/admin/update')).body;
  assert.equal(seen.state, 'available');
  assert.equal(seen.behind, 2);
  assert.equal((await admin('POST', '/api/admin/update/apply', {})).status, 400);
  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: 'yes' })).status, 400);
  assert.equal(selfUpdate.hasRequest(dataDir), false);

  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: true })).status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, selfUpdate.REQUEST_FILE), 'utf8')).action, 'apply');
  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: true })).status, 409, 'not twice');
  const log = (await admin('GET', '/api/admin/activity?filter=settings')).body.entries.map((e) => e.detail);
  assert.ok(log.some((d) => /Roost update started \(2 changes\)/.test(d)));
  clear();
});

test('there has to be something new, and your own edits to the same file stop it', async () => {
  report({ behind: 0, commits: [] });
  const none = await admin('POST', '/api/admin/update/apply', { confirm: true });
  assert.equal(none.status, 409);
  report({ conflicts: ['docker-compose.yml'] });
  const conflict = await admin('POST', '/api/admin/update/apply', { confirm: true });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /docker-compose\.override\.yml/);
  report({ state: 'applying', phase: 'build' });
  assert.equal((await admin('GET', '/api/admin/update')).body.state, 'applying');
  assert.equal((await admin('POST', '/api/admin/update/apply', { confirm: true })).status, 409);
  assert.equal((await admin('POST', '/api/admin/update/check')).status, 409);
  assert.equal(selfUpdate.hasRequest(dataDir), false);
});

test('Check now leaves a request', async () => {
  report();
  assert.equal((await admin('POST', '/api/admin/update/check')).status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, selfUpdate.REQUEST_FILE), 'utf8')).action, 'check');
  assert.equal((await admin('GET', '/api/admin/update')).body.requested, true);
  clear();
});

test('how an update went is written to the activity log once', async () => {
  const finishedAt = new Date().toISOString();
  report({ behind: 0, commits: [], last: { ok: true, from: 'a'.repeat(40), to: 'b'.repeat(40), count: 2, at: finishedAt, finishedAt } });
  const first = (await admin('GET', '/api/admin/update')).body;
  assert.equal(first.state, 'current');
  assert.equal(first.last.ok, true);
  await admin('GET', '/api/admin/update');
  const details = () => admin('GET', '/api/admin/activity?filter=settings').then((r) => r.body.entries.map((e) => e.detail));
  assert.equal((await details()).filter((d) => /Roost updated to bbbbbbb/.test(d)).length, 1);

  const failedAt = new Date(Date.now() + 1000).toISOString();
  report({ last: { ok: false, error: 'The new version didn’t build.', rolledBack: true, at: failedAt, finishedAt: failedAt } });
  await admin('GET', '/api/admin/update');
  await admin('GET', '/api/admin/update');
  assert.equal((await details()).filter((d) => /failed and was rolled back: The new version didn’t build/.test(d)).length, 1);
});

test('the setup checklist has a step for it', async () => {
  const steps = (await admin('GET', '/api/admin/setup')).body.steps;
  const step = steps.find((s) => s.id === 'self-update');
  assert.ok(step && step.optional);
  assert.equal(step.done, true, 'ticks off once the updater has looked at GitHub');
  fs.rmSync(path.join(dataDir, selfUpdate.STATUS_FILE));
  assert.equal((await admin('GET', '/api/admin/setup')).body.steps.find((s) => s.id === 'self-update').done, false);
});
