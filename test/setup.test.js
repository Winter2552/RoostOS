'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { STEPS } = require('../src/setup');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let adminCookie;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-setup-'));
  // Mail "sent" in these tests always works.
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', sendMail: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, adminCookie);
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

const stepDone = async (id) => (await call('GET', '/api/admin/setup', null, adminCookie)).body.steps.find((s) => s.id === id).done;

test('every step explains itself', () => {
  const ids = new Set();
  for (const s of STEPS) {
    assert.ok(s.id && s.group && s.title && s.why && s.how.length, s.id);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.equal(typeof s.check, 'function');
  }
});

test('the checklist is for admins only', async () => {
  assert.equal((await call('GET', '/api/admin/setup')).status, 401);
});

test('a fresh Roost shows what is left to do', async () => {
  const { body } = await call('GET', '/api/admin/setup', null, adminCookie);
  assert.equal(body.total, STEPS.filter((s) => !s.optional).length);
  assert.ok(body.done < body.total);
  assert.equal(body.steps.find((s) => s.id === 'docker').done, false);
  assert.equal(body.steps.find((s) => s.id === 'public-address').done, false);
  assert.equal(body.steps[0].check, undefined);
});

test('steps tick off as things get set up', async () => {
  await call('PATCH', '/api/admin/settings', { publicUrl: 'https://roostos.network' }, adminCookie);
  assert.equal(await stepDone('public-address'), true);

  await call('PATCH', '/api/me', { email: 'raven@example.com' }, adminCookie);
  assert.equal(await stepDone('admin-email'), true);

  await call('POST', '/api/admin/invites', {}, adminCookie);
  assert.equal(await stepDone('invite'), true);
});

test('email counts once a test email went through, until the settings change', async () => {
  const relay = { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'u', password: 'p', from: 'server@roostos.network' };
  await call('PATCH', '/api/admin/settings', { mail: relay }, adminCookie);
  assert.equal(await stepDone('email'), false);
  assert.equal((await call('POST', '/api/admin/mail-test', {}, adminCookie)).status, 200);
  assert.equal(await stepDone('email'), true);
  // Saving the same settings (password left blank) keeps it.
  await call('PATCH', '/api/admin/settings', { mail: { ...relay, password: '' } }, adminCookie);
  assert.equal(await stepDone('email'), true);
  await call('PATCH', '/api/admin/settings', { mail: { ...relay, host: 'smtp.other.com' } }, adminCookie);
  assert.equal(await stepDone('email'), false);
});

test('steps Roost cannot see are ticked by hand', async () => {
  assert.equal((await call('POST', '/api/admin/setup/public-address', { done: true }, adminCookie)).status, 400);
  await call('POST', '/api/admin/setup/email-replies', { done: true }, adminCookie);
  assert.equal(await stepDone('email-replies'), true);
  await call('POST', '/api/admin/setup/email-replies', { done: false }, adminCookie);
  assert.equal(await stepDone('email-replies'), false);
});

test('backup steps tick off from what the backup service reports', async () => {
  assert.equal(await stepDone('backup-drive'), false);
  assert.equal((await call('GET', '/api/backup', null, adminCookie)).body.state, 'off');

  const backup = require('../src/backup');
  backup.writeStatus(dataDir, { drive: { ok: true, total: 1e12, free: 9e11 }, lastOk: null, snapshots: [] });
  assert.equal(await stepDone('backup-drive'), true);
  assert.equal(await stepDone('first-backup'), false);
  assert.equal((await call('GET', '/api/backup', null, adminCookie)).body.state, 'none');

  const done = new Date().toISOString();
  backup.writeStatus(dataDir, { drive: { ok: true }, lastOk: done, last: { ok: true, files: 3 }, snapshots: [] });
  assert.equal(await stepDone('first-backup'), true);
  const b = (await call('GET', '/api/backup', null, adminCookie)).body;
  assert.equal(b.state, 'ok');
  assert.equal(b.lastOk, done);
  assert.equal(b.last.files, 3);
  assert.equal((await call('GET', '/api/backup')).status, 401);
});
