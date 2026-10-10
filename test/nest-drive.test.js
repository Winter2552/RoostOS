'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../updater/update-service');
const { mergeOverride } = require('../updater/override');
const nestDrive = require('../src/nest-drive');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `roost-${name}-`));

test('the override file gets the three mounts, keeping everything else', () => {
  const merged = mergeOverride('services:\n  roost-backup:\n    environment:\n      TZ: Europe/London\n    volumes:\n      - /media/USB:/backup\n      - /DATA/roost-nest:/source/nest:ro\n  roost:\n    volumes:\n      - /DATA:/hostfs/data:ro\n      - /x:/y\n', '/media/hdd', '/media/hdd/roost-nest');
  assert.match(merged, /TZ: Europe\/London/);
  assert.match(merged, /- \/media\/USB:\/backup/);
  assert.match(merged, /- \/x:\/y/);
  assert.match(merged, /- \/media\/hdd\/roost-nest:\/nest\n/);
  assert.match(merged, /- \/media\/hdd:\/hostfs\/data:ro/);
  assert.match(merged, /- \/media\/hdd\/roost-nest:\/source\/nest:ro/);
  assert.equal(merged.includes('/DATA'), false);
  // Doing it twice changes nothing more.
  assert.equal(mergeOverride(merged, '/media/hdd', '/media/hdd/roost-nest'), merged);
});

test('a missing override file is made, and a file without services is left alone', () => {
  assert.match(mergeOverride('', '/media/hdd', '/media/hdd/roost-nest'), /^services:\n {2}roost:\n {4}volumes:/);
  assert.throws(() => mergeOverride('version: 3\n', '/media/hdd', '/n'), /no "services:"/);
});

test('hasFiles ignores empty folders but sees any file', () => {
  const dir = tmp('nest');
  try {
    fs.mkdirSync(path.join(dir, 'raven_1', 'files'), { recursive: true });
    assert.equal(nestDrive.hasFiles(dir), false);
    fs.writeFileSync(path.join(dir, 'raven_1', 'files', 'a.txt'), 'x');
    assert.equal(nestDrive.hasFiles(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the updater moving Nest, with a pretend Docker ----------

function world({ composeFails = false, health = ['healthy'], mounts } = {}) {
  const root = tmp('drive');
  const data = path.join(root, 'data');
  const src = path.join(root, 'src');
  const media = path.join(root, 'media');
  for (const d of [data, src, path.join(media, 'roosthdd')]) fs.mkdirSync(d, { recursive: true });
  const state = { source: '/DATA/roost-nest', calls: [] };
  const exec = async (cmd, args) => {
    const line = args.join(' ');
    state.calls.push(line);
    if (line.includes('com.docker.compose.project')) return { code: 0, out: 'roost' };
    if (line.includes('.Mounts')) return { code: 0, out: JSON.stringify([{ Destination: '/nest', Source: mounts || state.source }]) };
    if (line.startsWith('compose') && line.includes(' config')) return composeFails ? { code: 1, out: 'bad yaml' } : { code: 0, out: '' };
    if (line.startsWith('compose') && line.includes(' up ')) {
      const o = fs.existsSync(path.join(src, 'docker-compose.override.yml')) ? fs.readFileSync(path.join(src, 'docker-compose.override.yml'), 'utf8') : '';
      const m = o.match(/- (\S+):\/nest\n/);
      if (!mounts) state.source = m ? m[1] : '/DATA/roost-nest';
      return { code: 0, out: '' };
    }
    if (line.includes('State.Health')) return { code: 0, out: health[0] };
    return { code: 0, out: '' };
  };
  const drives = () => [{ name: 'roosthdd', totalBytes: 3e12, freeBytes: 3e12 }];
  const u = updater.create({ dataDir: data, srcDir: src, exec, wait: async () => {}, healthWaitMs: 10, mediaDir: media, mediaHost: '/media', drives });
  return { root, data, src, media, state, u, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const overrideOf = (w) => path.join(w.src, 'docker-compose.override.yml');

test('listing finds the plugged-in drives and where Nest is now', async () => {
  const w = world();
  try {
    nestDrive.writeRequest(w.data, { action: 'list' });
    await w.u.tick();
    const s = nestDrive.readStatus(w.data);
    assert.equal(s.current, '/DATA/roost-nest');
    assert.equal(s.drives[0].name, 'roosthdd');
    assert.equal(nestDrive.hasRequest(w.data), false);
  } finally { w.done(); }
});

test('moving makes the folder, writes the override and restarts Roost', async () => {
  const w = world();
  try {
    nestDrive.writeRequest(w.data, { action: 'move', drive: 'roosthdd' });
    await w.u.tick();
    const s = nestDrive.readStatus(w.data);
    assert.equal(s.last.ok, true, JSON.stringify(s.last));
    assert.equal(s.last.to, '/media/roosthdd/roost-nest');
    assert.equal(s.current, '/media/roosthdd/roost-nest');
    assert.ok(fs.existsSync(path.join(w.media, 'roosthdd', 'roost-nest')));
    assert.match(fs.readFileSync(overrideOf(w), 'utf8'), /\/media\/roosthdd\/roost-nest:\/nest/);
    assert.ok(w.state.calls.some((c) => c.includes('up -d --no-deps roost roost-backup')));
  } finally { w.done(); }
});

test('a failed check puts the old override back and starts Roost on it', async () => {
  const w = world({ composeFails: true });
  try {
    fs.writeFileSync(overrideOf(w), 'services:\n  roost:\n    environment:\n      A: "1"\n');
    const before = fs.readFileSync(overrideOf(w), 'utf8');
    nestDrive.writeRequest(w.data, { action: 'move', drive: 'roosthdd' });
    await w.u.tick();
    const s = nestDrive.readStatus(w.data);
    assert.equal(s.last.ok, false);
    assert.match(s.last.error, /Docker's check/);
    assert.equal(fs.readFileSync(overrideOf(w), 'utf8'), before);
  } finally { w.done(); }
});

test('Roost that never starts on the new drive is rolled back, and a missing override is removed', async () => {
  const w = world({ health: ['unhealthy'] });
  try {
    nestDrive.writeRequest(w.data, { action: 'move', drive: 'roosthdd' });
    await w.u.tick();
    const s = nestDrive.readStatus(w.data);
    assert.equal(s.last.ok, false);
    assert.match(s.last.error, /didn't start properly/);
    assert.equal(fs.existsSync(overrideOf(w)), false);
  } finally { w.done(); }
});

test('an unknown drive or a path-like name is refused', async () => {
  const w = world();
  try {
    for (const drive of ['usb', '../etc']) {
      nestDrive.writeRequest(w.data, { action: 'move', drive });
      await w.u.tick();
      assert.equal(nestDrive.readStatus(w.data).last.ok, false);
    }
    assert.equal(fs.existsSync(overrideOf(w)), false);
  } finally { w.done(); }
});

// ---------- the Admin routes ----------

let server; let base; let dataDir; let nestDir; let adminCookie; let userCookie;

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

before(async () => {
  dataDir = tmp('nd-data');
  nestDir = tmp('nd-nest');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
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
  fs.rmSync(nestDir, { recursive: true, force: true });
});

const heartbeat = () => fs.writeFileSync(path.join(dataDir, 'update-status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), head: { sha: 'a' }, state: 'idle' }));
const driveStatus = (extra = {}) => fs.writeFileSync(path.join(dataDir, 'nest-drive-status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), state: 'idle', current: '/DATA/roost-nest', drives: [{ name: 'roosthdd', totalBytes: 3e12, freeBytes: 3e12 }], ...extra }));

test('only admins see or use the drive card', async () => {
  assert.equal((await call('GET', '/api/admin/nest-drive', null, userCookie)).status, 403);
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd', confirm: true }, userCookie)).status, 403);
});

test('without the updater the card is off and moving is refused', async () => {
  const r = await call('GET', '/api/admin/nest-drive', null, adminCookie);
  assert.equal(r.body.updater, 'off');
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd', confirm: true }, adminCookie)).status, 409);
});

test('an empty Nest can be moved to a listed drive, after confirming', async () => {
  heartbeat();
  driveStatus();
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd' }, adminCookie)).status, 400);
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'nope', confirm: true }, adminCookie)).status, 404);
  const r = await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd', confirm: true }, adminCookie);
  assert.equal(r.status, 202);
  const asked = JSON.parse(fs.readFileSync(path.join(dataDir, 'nest-drive-request.json'), 'utf8'));
  assert.equal(asked.action, 'move');
  assert.equal(asked.drive, 'roosthdd');
  // A second press while it is on its way.
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd', confirm: true }, adminCookie)).status, 409);
  fs.rmSync(path.join(dataDir, 'nest-drive-request.json'));
});

test('a Nest with files in it is not moved', async () => {
  heartbeat();
  driveStatus();
  fs.mkdirSync(path.join(nestDir, 'sam_2', 'files'), { recursive: true });
  fs.writeFileSync(path.join(nestDir, 'sam_2', 'files', 'a.txt'), 'x');
  const card = await call('GET', '/api/admin/nest-drive', null, adminCookie);
  assert.equal(card.body.empty, false);
  assert.equal((await call('POST', '/api/admin/nest-drive/move', { drive: 'roosthdd', confirm: true }, adminCookie)).status, 409);
  fs.rmSync(path.join(nestDir, 'sam_2'), { recursive: true });
});

test('the card knows when Nest is already on a drive', async () => {
  heartbeat();
  driveStatus({ current: '/media/roosthdd/roost-nest' });
  const r = await call('GET', '/api/admin/nest-drive', null, adminCookie);
  assert.equal(r.body.onDrive, true);
});
