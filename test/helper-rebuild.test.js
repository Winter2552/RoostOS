'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../updater/update-service');
const selfUpdate = require('../src/self-update');
const { createServer } = require('../src/server');
const { STEPS } = require('../src/setup');
const { setUpTwoStep } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-helper-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Pretend Docker: records the calls and answers as told.
function fakeDocker({ upFails = false, state = 'running', configFails = false } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line.includes(' config ')) return configFails ? { code: 1, out: 'bad yaml' } : { code: 0, out: '' };
    if (line.includes(' up ')) return upFails ? { code: 1, out: 'no such device /dev/sdb' } : { code: 0, out: '' };
    if (line.includes('State.Health')) return { code: 0, out: state };
    if (line.startsWith('logs')) return { code: 0, out: 'smartctl: not found\nexiting' };
    return { code: 0, out: '' };
  };
  return { exec, calls };
}

const make = (data, docker) => updater.create({ dataDir: data, srcDir: tmp, exec: docker.exec, wait: async () => {}, healthWaitMs: 1000 });
const folder = (name) => fs.mkdirSync(path.join(tmp, name), { recursive: true }) && path.join(tmp, name);

test('the updater writes a helper status at start, so Roost knows it can do this', () => {
  const data = folder('a');
  make(data, fakeDocker());
  assert.equal(selfUpdate.readHelperStatus(data).state, 'idle');
});

test('a helper request rebuilds only roost-smart, and never touches Roost', async () => {
  const data = folder('b');
  const d = fakeDocker();
  const u = make(data, d);
  selfUpdate.writeRequest(data, 'helper');
  await u.tick();
  assert.equal(selfUpdate.hasRequest(data), false);
  const up = d.calls.find((c) => c.includes(' up '));
  assert.match(up, /compose -p roost up -d --build --no-deps roost-smart$/);
  assert.ok(!d.calls.some((c) => /\broost\b(?! ?-smart)\s*$/.test(c) && c.includes(' up ')));
  const last = selfUpdate.readHelperStatus(data).last;
  assert.equal(last.ok, true);
  assert.equal(selfUpdate.readHelperStatus(data).state, 'idle');
});

test('a build that fails says why, with the last lines of Docker’s answer', async () => {
  const data = folder('c');
  const u = make(data, fakeDocker({ upFails: true }));
  await u.rebuildHelper();
  const last = selfUpdate.readHelperStatus(data).last;
  assert.equal(last.ok, false);
  assert.match(last.error, /couldn't be built or started/);
  assert.match(last.detail, /no such device \/dev\/sdb/);

  const bad = make(folder('c2'), fakeDocker({ configFails: true }));
  await bad.rebuildHelper();
  assert.match(bad.helperStatus().last.error, /compose file/);
});

test('a helper that starts and then stops is reported, not called done', async () => {
  const data = folder('d');
  const u = make(data, fakeDocker({ state: 'exited' }));
  await u.rebuildHelper();
  const last = selfUpdate.readHelperStatus(data).last;
  assert.equal(last.ok, false);
  assert.match(last.error, /didn't stay running \(exited\)/);
  assert.match(last.detail, /smartctl: not found/);
});

test('summarizeHelper needs a new enough updater that is alive', () => {
  const helper = { state: 'idle', last: { ok: true, finishedAt: 'x' } };
  assert.equal(selfUpdate.summarizeHelper(null, 'current', false).capable, false);
  assert.equal(selfUpdate.summarizeHelper(helper, 'off', false).capable, false);
  assert.equal(selfUpdate.summarizeHelper(helper, 'stopped', false).capable, false);
  assert.equal(selfUpdate.summarizeHelper(helper, 'current', false).capable, true);
  assert.equal(selfUpdate.summarizeHelper(helper, 'current', true).building, true);
  assert.equal(selfUpdate.summarizeHelper({ ...helper, state: 'building' }, 'current', false).building, true);
});

test('Status offers the button to admins only, and one press leaves one request and a log entry', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, cookie) => {
      const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
    };
    const adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, adminCookie);
    await call('POST', '/api/admin/users', { username: 'sam', password: 'sam sam sam' }, adminCookie);
    const userCookie = (await call('POST', '/api/login', { username: 'sam', password: 'sam sam sam' })).cookie;
    const admin = (m, u, b) => call(m, u, b, adminCookie);

    assert.equal((await call('POST', '/api/admin/helper/rebuild', null, userCookie)).status, 403);
    assert.equal((await call('GET', '/api/status', null, userCookie)).body.helper, null);

    // No updater at all: told how to start it, nothing requested.
    assert.equal((await admin('GET', '/api/status')).body.helper.capable, false);
    const refused = await admin('POST', '/api/admin/helper/rebuild');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /--build roost-updater roost-smart/);

    // An updater from before this existed (no helper status) still can't.
    fs.writeFileSync(path.join(dataDir, selfUpdate.STATUS_FILE), JSON.stringify({ updatedAt: new Date().toISOString(), state: 'idle', head: { sha: 'a', short: 'a', subject: 'x' }, behind: 0 }));
    assert.equal((await admin('GET', '/api/status')).body.helper.capable, false);

    // A current one can: one request, one log line, not twice.
    fs.writeFileSync(path.join(dataDir, selfUpdate.HELPER_FILE), JSON.stringify({ state: 'idle', last: null, updatedAt: new Date().toISOString() }));
    assert.equal((await admin('GET', '/api/status')).body.helper.capable, true);
    assert.equal((await admin('POST', '/api/admin/helper/rebuild')).status, 202);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, selfUpdate.REQUEST_FILE), 'utf8')).action, 'helper');
    assert.equal((await admin('GET', '/api/status')).body.helper.building, true);
    assert.equal((await admin('POST', '/api/admin/helper/rebuild')).status, 409);
    const log = (await admin('GET', '/api/admin/activity?filter=settings')).body.entries.map((e) => e.detail);
    assert.ok(log.some((x) => /Power and heat helper rebuild started/.test(x)));
  } finally {
    server.close();
  }
});

test('the setup step for power and heat mentions the button', () => {
  const step = STEPS.find((s) => s.id === 'power-heat');
  assert.ok(step.how.some((line) => /Set up power and heat/.test(line)));
});
