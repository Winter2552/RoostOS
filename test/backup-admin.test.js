'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const backup = require('../src/backup');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let adminCookie;
let userCookie;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-backup-admin-'));
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
const clearRequest = () => backup.takeRequest(dataDir);

// What the backup service would have written, fresh enough to count as running.
const service = (extra = {}) => backup.writeStatus(dataDir, { drive: { ok: true, total: 1e12, free: 6e11 }, lastOk: new Date().toISOString(), last: { ok: true }, history: [], snapshots: [], ...extra });

test('only admins see or control backups', async () => {
  for (const [method, url] of [['GET', '/api/admin/backup'], ['POST', '/api/admin/backup/run'], ['POST', '/api/admin/backup/cancel']]) {
    assert.equal((await call(method, url)).status, 401, url);
    assert.equal((await call(method, url, null, userCookie)).status, 403, url);
  }
  assert.equal(backup.hasRequest(dataDir), false);
});

test('before the service has ever reported, Back up now says why not', async () => {
  const res = await admin('GET', '/api/admin/backup');
  assert.equal(res.body.state, 'off');
  assert.deepEqual(res.body.config, { time: '03:00', keepDaily: 7, keepWeekly: 4, capGb: null });
  const run = await admin('POST', '/api/admin/backup/run');
  assert.equal(run.status, 409);
  assert.match(run.body.error, /isn’t running/);
  assert.equal(backup.hasRequest(dataDir), false);
});

test('Back up now leaves a request for the service, once the drive is there', async () => {
  service({ drive: { ok: false, message: 'Backup drive not found' } });
  const noDrive = await admin('POST', '/api/admin/backup/run');
  assert.equal(noDrive.status, 409);
  assert.match(noDrive.body.error, /drive not found/i);

  service({ history: [{ ok: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), files: 3, linked: 1, written: 10, manual: false }], snapshots: [{ name: 'a', at: '2026-10-08T03:00:00Z' }, { name: 'b', at: '2026-10-07T03:00:00Z' }] });
  const view = (await admin('GET', '/api/admin/backup')).body;
  assert.equal(view.state, 'ok');
  assert.equal(view.history.length, 1);
  assert.deepEqual(view.snapshots, { count: 2, newest: '2026-10-08T03:00:00Z', oldest: '2026-10-07T03:00:00Z' });
  assert.equal(view.requested, false);

  assert.equal((await admin('POST', '/api/admin/backup/run')).status, 202);
  assert.equal((await admin('GET', '/api/admin/backup')).body.requested, true);
  assert.equal(clearRequest(), 'run');
});

test('a backup that is running can be cancelled, and not started twice', async () => {
  service({ running: true, progress: { startedAt: new Date().toISOString(), files: 12, written: 100 } });
  const view = (await admin('GET', '/api/admin/backup')).body;
  assert.equal(view.state, 'running');
  assert.equal(view.progress.files, 12);
  assert.equal((await admin('POST', '/api/admin/backup/run')).status, 409);
  assert.equal((await admin('POST', '/api/admin/backup/cancel')).status, 202);
  assert.equal(clearRequest(), 'cancel');

  service();
  assert.equal((await admin('POST', '/api/admin/backup/cancel')).status, 409);
  assert.equal(backup.hasRequest(dataDir), false);
});

test('a service that stopped checking in is reported as stopped', async () => {
  service();
  const file = path.join(dataDir, backup.STATUS_FILE);
  const status = JSON.parse(fs.readFileSync(file, 'utf8'));
  status.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(status));
  assert.equal((await admin('GET', '/api/admin/backup')).body.state, 'stopped');
  assert.equal((await admin('POST', '/api/admin/backup/run')).status, 409);
});

test('backup settings are saved, checked, logged and passed to the service', async () => {
  const bad = await admin('PATCH', '/api/admin/settings', { backup: { time: '03:00', keepDaily: 99, keepWeekly: 4, capGb: '' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Nightly backups to keep/);
  assert.equal(backup.hasRequest(dataDir), false);

  const ok = await admin('PATCH', '/api/admin/settings', { backup: { time: '04:30', keepDaily: '10', keepWeekly: '2', capGb: '500' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.settings.backup, { time: '04:30', keepDaily: 10, keepWeekly: 2, capGb: 500 });
  assert.equal(clearRequest(), 'reload');
  assert.deepEqual((await admin('GET', '/api/admin/backup')).body.config, { time: '04:30', keepDaily: 10, keepWeekly: 2, capGb: 500 });

  // Saving the same settings again changes nothing, so the service isn't bothered.
  await admin('PATCH', '/api/admin/settings', { backup: { time: '04:30', keepDaily: 10, keepWeekly: 2, capGb: 500 } });
  assert.equal(backup.hasRequest(dataDir), false);

  const log = (await admin('GET', '/api/admin/activity')).body.entries;
  assert.ok(log.some((e) => e.type === 'settings-changed' && /backups 04:30, keep 10 nightly \+ 2 weekly, up to 500 GB/.test(e.detail)));
  await admin('POST', '/api/admin/backup/cancel');
});
