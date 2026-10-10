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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-links-'));
  server = createServer({ dataDir });
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

const readDb = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8'));

test('only admins can make invites', async () => {
  assert.equal((await call('POST', '/api/admin/invites', {})).status, 401);
});

test('an invite link lets someone make their own account, once', async () => {
  const made = await call('POST', '/api/admin/invites', { label: 'Mum', apps: ['jellyfin', 'glint'], limitGb: 20 }, adminCookie);
  assert.equal(made.status, 201);
  assert.match(made.body.token, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(made.body.invite.tokenHash, undefined);
  const { token } = made.body;

  // Only a hash of the link is written to disk.
  assert.ok(!JSON.stringify(readDb()).includes(token.replace('-', '')));

  // Typed by hand: any case, with or without the dash.
  assert.equal((await call('GET', `/api/links/${token.replace('-', '').toLowerCase()}`)).status, 200);

  const info = await call('GET', `/api/links/${token}`);
  assert.equal(info.body.kind, 'invite');
  assert.equal(info.body.invitedBy, 'Raven');
  assert.deepEqual(info.body.apps, ['Jellyfin', 'Glint']);

  assert.equal((await call('GET', `/api/links/${token}?username=raven`)).body.available, false);
  assert.equal((await call('GET', `/api/links/${token}?username=A!`)).body.available, false);
  assert.equal((await call('GET', `/api/links/${token}?username=mum`)).body.available, true);

  assert.equal((await call('POST', `/api/links/${token}`, { username: 'mum', password: 'short' })).status, 400);
  assert.equal((await call('POST', `/api/links/${token}`, { username: 'raven', password: 'long enough' })).status, 409);

  const joined = await call('POST', `/api/links/${token}`, { username: 'Mum', displayName: 'Mum', password: 'long enough' });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.user.username, 'mum');
  assert.equal(joined.body.user.role, 'user');
  assert.ok(joined.cookie);

  const apps = await call('GET', '/api/apps', null, joined.cookie);
  assert.deepEqual(apps.body.apps.map((a) => a.id), ['jellyfin', 'glint']);
  assert.equal(readDb().users.find((u) => u.username === 'mum').limitGb, 20);

  // Used up.
  assert.equal((await call('GET', `/api/links/${token}`)).status, 404);
  assert.equal((await call('POST', `/api/links/${token}`, { username: 'mum2', password: 'long enough' })).status, 404);
});

test('admins see and cancel pending invites', async () => {
  const made = await call('POST', '/api/admin/invites', { role: 'admin' }, adminCookie);
  const list = await call('GET', '/api/admin/invites', null, adminCookie);
  assert.deepEqual(list.body.invites.map((i) => i.id), [made.body.invite.id]);
  assert.equal(list.body.invites[0].role, 'admin');
  assert.equal((await call('DELETE', `/api/admin/invites/${made.body.invite.id}`, null, adminCookie)).status, 200);
  assert.equal((await call('GET', `/api/links/${made.body.token}`)).status, 404);
});

test('invites run out after 7 days', async () => {
  const made = await call('POST', '/api/admin/invites', {}, adminCookie);
  const days = (Date.parse(made.body.invite.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 6.99 && days <= 7);
  const db = readDb();
  // Age the invite on disk, then load a fresh server from the same folder.
  db.links[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'roost.json'), JSON.stringify(db));
  const other = createServer({ dataDir });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${other.address().port}/api/links/${made.body.token}`);
  assert.equal(res.status, 404);
  other.close();
});

test('a reset link sets a new password and signs out old sessions', async () => {
  const mum = readDb().users.find((u) => u.username === 'mum');
  const oldCookie = (await call('POST', '/api/login', { username: 'mum', password: 'long enough' })).cookie;
  assert.equal((await call('POST', `/api/admin/users/${mum.id}/reset-link`)).status, 401);

  const first = await call('POST', `/api/admin/users/${mum.id}/reset-link`, null, adminCookie);
  const second = await call('POST', `/api/admin/users/${mum.id}/reset-link`, null, adminCookie);
  assert.equal(second.status, 201);
  // Only the newest reset link works.
  assert.equal((await call('GET', `/api/links/${first.body.token}`)).status, 404);

  const info = await call('GET', `/api/links/${second.body.token}`);
  assert.equal(info.body.kind, 'reset');
  assert.equal(info.body.username, 'mum');

  const done = await call('POST', `/api/links/${second.body.token}`, { password: 'brand new pass' });
  assert.equal(done.status, 200);
  assert.ok(done.cookie);
  assert.equal((await call('GET', '/api/apps', null, oldCookie)).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'mum', password: 'brand new pass' })).status, 200);
  assert.equal((await call('POST', `/api/links/${second.body.token}`, { password: 'again again' })).status, 404);
});

test('deleting a user removes their reset links', async () => {
  const mum = readDb().users.find((u) => u.username === 'mum');
  const link = await call('POST', `/api/admin/users/${mum.id}/reset-link`, null, adminCookie);
  await call('DELETE', `/api/admin/users/${mum.id}`, null, adminCookie);
  assert.equal((await call('GET', `/api/links/${link.body.token}`)).status, 404);
});

test('bad links are refused and guessing is rate limited', async () => {
  assert.equal((await call('GET', '/api/links/OOOO-1111')).status, 404);
  let last;
  for (let i = 0; i < 12; i++) last = await call('GET', '/api/links/2222-2222');
  assert.equal(last.status, 429);
});

test('the public address is used for links and must be a web address', async () => {
  const bad = await call('PATCH', '/api/admin/settings', { publicUrl: 'ftp://x' }, adminCookie);
  assert.equal(bad.status, 400);
  const ok = await call('PATCH', '/api/admin/settings', { publicUrl: 'roostos.network/' }, adminCookie);
  assert.equal(ok.body.settings.publicUrl, 'https://roostos.network');
  assert.equal((await call('GET', '/api/admin/invites', null, adminCookie)).body.publicUrl, 'https://roostos.network');
  assert.equal((await call('PATCH', '/api/admin/settings', { publicUrl: '' }, adminCookie)).body.settings.publicUrl, '');
});

test('link pages are served at /j/ and /r/', async () => {
  const res = await fetch(`${base}/j/K7PX-2QM9`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="join"/);
});

test('invites and reset links show in the activity log', async () => {
  const { body } = await call('GET', '/api/admin/activity?filter=users', null, adminCookie);
  const types = body.entries.map((e) => e.type);
  for (const t of ['invite-created', 'invite-removed', 'user-joined', 'reset-link-created', 'password-reset']) {
    assert.ok(types.includes(t), `missing ${t}`);
  }
  assert.equal(body.entries.find((e) => e.type === 'user-joined').actor, 'mum');
});
