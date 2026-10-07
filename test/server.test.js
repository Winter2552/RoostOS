'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-test-'));
  server = createServer({ dataDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
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

let adminCookie;
let userCookie;
let userId;

test('first run asks for setup and serves the page', async () => {
  const s = await call('GET', '/api/state');
  assert.equal(s.body.setupRequired, true);
  assert.equal(s.body.user, null);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Roost/);
});

test('apps need a signed-in user', async () => {
  assert.equal((await call('GET', '/api/apps')).status, 401);
});

test('setup creates the admin once', async () => {
  const short = await call('POST', '/api/setup', { username: 'raven', password: 'short' });
  assert.equal(short.status, 400);
  const ok = await call('POST', '/api/setup', { username: 'Raven', password: 'correct horse', displayName: 'Raven' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'admin');
  assert.equal(ok.body.user.username, 'raven');
  assert.equal(ok.body.user.password, undefined);
  adminCookie = ok.cookie;
  const again = await call('POST', '/api/setup', { username: 'other', password: 'correct horse' });
  assert.equal(again.status, 409);
});

test('setup requires a JSON body', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', body: 'username=raven' });
  assert.equal(res.status, 415);
});

test('login checks the password', async () => {
  assert.equal((await call('POST', '/api/login', { username: 'raven', password: 'wrong pass' })).status, 401);
  const ok = await call('POST', '/api/login', { username: 'RAVEN', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
});

test('admin sees the four default apps', async () => {
  const { body } = await call('GET', '/api/apps', null, adminCookie);
  assert.deepEqual(body.apps.map((a) => a.name), ['Jellyfin', 'Nova', 'Nest', 'Glint']);
});

test('admin can add a user limited to some apps', async () => {
  const res = await call('POST', '/api/admin/users',
    { username: 'guest', password: 'guest pass 1', displayName: 'Guest', apps: ['jellyfin', 'glint', 'bogus'] }, adminCookie);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.user.apps, ['jellyfin', 'glint']);
  userId = res.body.user.id;
  userCookie = (await call('POST', '/api/login', { username: 'guest', password: 'guest pass 1' })).cookie;
  const { body } = await call('GET', '/api/apps', null, userCookie);
  assert.deepEqual(body.apps.map((a) => a.id), ['jellyfin', 'glint']);
});

test('regular users cannot use admin routes', async () => {
  assert.equal((await call('GET', '/api/admin/users', null, userCookie)).status, 403);
  assert.equal((await call('PUT', '/api/admin/apps', { apps: [] }, userCookie)).status, 403);
});

test('app links must be http(s)', async () => {
  const bad = await call('PUT', '/api/admin/apps', { apps: [{ name: 'X', url: 'javascript:alert(1)' }] }, adminCookie);
  assert.equal(bad.status, 400);
  const { body: { apps } } = await call('GET', '/api/apps', null, adminCookie);
  apps[2].url = 'http://{host}:8443';
  const ok = await call('PUT', '/api/admin/apps', { apps }, adminCookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.apps[2].url, 'http://{host}:8443');
});

test('status reports unset apps without probing', async () => {
  const { body } = await call('GET', '/api/apps/status', null, userCookie);
  assert.equal(body.status.glint, 'unset');
  assert.ok(['online', 'offline'].includes(body.status.jellyfin));
});

test('users can rename themselves and change password', async () => {
  const renamed = await call('PATCH', '/api/me', { displayName: 'Guest Room' }, userCookie);
  assert.equal(renamed.body.user.displayName, 'Guest Room');
  const wrong = await call('PATCH', '/api/me', { currentPassword: 'nope', newPassword: 'new pass 123' }, userCookie);
  assert.equal(wrong.status, 400);
  const ok = await call('PATCH', '/api/me', { currentPassword: 'guest pass 1', newPassword: 'new pass 123' }, userCookie);
  assert.equal(ok.status, 200);
});

test('admin cannot delete themselves but can delete others', async () => {
  const { body } = await call('GET', '/api/admin/users', null, adminCookie);
  const me = body.users.find((u) => u.username === 'raven');
  assert.equal((await call('DELETE', `/api/admin/users/${me.id}`, null, adminCookie)).status, 400);
  assert.equal((await call('DELETE', `/api/admin/users/${userId}`, null, adminCookie)).status, 200);
  assert.equal((await call('GET', '/api/apps', null, userCookie)).status, 401);
});

test('data persists to disk', () => {
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8'));
  assert.equal(db.users.length, 1);
  assert.match(db.users[0].password, /^scrypt:/);
});

test('static files cannot escape the public folder', async () => {
  const res = await fetch(base + '/..%2fsrc%2fserver.js');
  assert.equal(res.status, 404);
});

test('logout ends the session', async () => {
  await call('POST', '/api/logout', null, adminCookie);
  assert.equal((await call('GET', '/api/apps', null, adminCookie)).status, 401);
});
