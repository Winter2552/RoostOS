'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let adminCookie;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-guests-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse', displayName: 'Raven' })).cookie;
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

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const signIn = (username) => call('POST', '/api/login', { username, password: 'long enough' });

test('a guest pass needs an end date within a year', async () => {
  for (const guestUntil of [undefined, 'soon', inDays(-1), inDays(400)]) {
    assert.equal((await call('POST', '/api/admin/invites', { role: 'guest', guestUntil }, adminCookie)).status, 400, String(guestUntil));
  }
});

test('a guest invite makes a guest who sees only their apps and nothing about the server', async () => {
  const until = inDays(7);
  const made = await call('POST', '/api/admin/invites', { label: 'Sam', role: 'guest', apps: ['jellyfin'], limitGb: 1, guestUntil: until }, adminCookie);
  assert.equal(made.status, 201);
  assert.equal(made.body.invite.guestUntil, until);
  const info = await call('GET', `/api/links/${made.body.token}`);
  assert.equal(info.body.role, 'guest');
  assert.equal(info.body.guestUntil, until);

  const joined = await call('POST', `/api/links/${made.body.token}`, { username: 'sam', password: 'long enough' });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.user.role, 'guest');
  assert.equal(joined.body.user.guestUntil, until);
  const cookie = joined.cookie;

  assert.deepEqual((await call('GET', '/api/apps', null, cookie)).body.apps.map((a) => a.id), ['jellyfin']);
  assert.equal((await call('GET', '/api/system', null, cookie)).status, 403);
  assert.equal((await call('GET', '/api/status', null, cookie)).status, 403);
  assert.equal((await call('POST', '/api/me/storage-requests', { requestedGb: 5 }, cookie)).status, 403);
  assert.equal((await call('GET', '/api/admin/users', null, cookie)).status, 403);
  assert.equal((await call('GET', '/api/nest/list', null, cookie)).status, 403);
});

test('a guest is signed out and turned away once the pass ends', async () => {
  const made = await call('POST', '/api/admin/invites', { role: 'guest', apps: ['jellyfin'], guestUntil: new Date(Date.now() + 1500).toISOString() }, adminCookie);
  const { cookie } = await call('POST', `/api/links/${made.body.token}`, { username: 'brief', password: 'long enough' });
  assert.equal((await call('GET', '/api/apps', null, cookie)).status, 200);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal((await call('GET', '/api/apps', null, cookie)).status, 401);
  const again = await signIn('brief');
  assert.equal(again.status, 403);
  assert.match(again.body.error, /guest pass has ended/);

  // Adding time lets them back in.
  const brief = (await call('GET', '/api/admin/users', null, adminCookie)).body.users.find((u) => u.username === 'brief');
  assert.equal((await call('PATCH', `/api/admin/users/${brief.id}`, { guestUntil: inDays(7) }, adminCookie)).status, 200);
  assert.equal((await signIn('brief')).status, 200);
});

test('an unused guest invite stops working when the pass ends', async () => {
  const made = await call('POST', '/api/admin/invites', { role: 'guest', guestUntil: new Date(Date.now() + 1000).toISOString() }, adminCookie);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await call('POST', `/api/links/${made.body.token}`, { username: 'late', password: 'long enough' })).status, 410);
});

test('admins can end a guest pass now and switch people to and from guest', async () => {
  const sam = (await call('GET', '/api/admin/users', null, adminCookie)).body.users.find((u) => u.username === 'sam');
  const { cookie } = await signIn('sam');
  assert.equal((await call('PATCH', `/api/admin/users/${sam.id}`, { endGuestPass: true }, adminCookie)).status, 200);
  assert.equal((await call('GET', '/api/apps', null, cookie)).status, 401);
  assert.equal((await signIn('sam')).status, 403);

  // A guest made a full user has no end date any more.
  const user = await call('PATCH', `/api/admin/users/${sam.id}`, { role: 'user' }, adminCookie);
  assert.equal(user.body.user.role, 'user');
  assert.equal(user.body.user.guestUntil, undefined);
  assert.equal((await signIn('sam')).status, 200);

  // Becoming a guest needs an end date.
  assert.equal((await call('PATCH', `/api/admin/users/${sam.id}`, { role: 'guest' }, adminCookie)).status, 400);
  const guest = await call('PATCH', `/api/admin/users/${sam.id}`, { role: 'guest', guestUntil: inDays(1) }, adminCookie);
  assert.equal(guest.body.user.role, 'guest');

  const log = (await call('GET', '/api/admin/activity', null, adminCookie)).body.entries;
  assert.ok(log.some((e) => e.type === 'user-changed' && /guest pass ended/.test(e.detail)));
  assert.ok(log.some((e) => e.type === 'sign-in-failed' && e.detail === 'guest pass ended'));
});
