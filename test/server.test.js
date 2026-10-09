'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const twoStep = require('../src/twostep');
const { setUpTwoStep, freshCode } = require('./helpers');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-test-'));
  server = createServer({ dataDir, probeTimeoutMs: 300, appToken: 'app-secret', maxFailedSignIns: 50 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const session = cookies.find((c) => c.startsWith('roost_session=') && c !== 'roost_session=');
  return { status: res.status, body: await res.json().catch(() => null), cookie: session || null, headers: cookies };
}

let adminCookie;
let userCookie;
let userId;
let adminSecret;
let adminRecovery;

test('first run asks for setup and serves the page', async () => {
  const s = await call('GET', '/api/state');
  assert.equal(s.body.setupRequired, true);
  assert.equal(s.body.user, null);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Roost/);
});

test('ping answers without a session and is never cached', async () => {
  const res = await fetch(base + '/api/ping');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('cache-control'), 'no-store');
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

test('admins must set up two-step sign-in before admin pages', async () => {
  const state = await call('GET', '/api/state', null, adminCookie);
  assert.equal(state.body.user.twoStep.required, true);
  assert.equal(state.body.user.twoStep.on, false);
  const blocked = await call('GET', '/api/admin/users', null, adminCookie);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /two-step/);
  // Everyday pages still work.
  assert.equal((await call('GET', '/api/apps', null, adminCookie)).status, 200);
});

test('two-step setup shows a QR code and needs a working code', async () => {
  const start = await call('POST', '/api/me/two-step/start', null, adminCookie);
  assert.equal(start.status, 200);
  assert.match(start.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(start.body.uri, /^otpauth:\/\/totp\/Roost%3Araven\?secret=/);
  assert.match(start.body.qr, /^<svg /);
  adminSecret = start.body.secret;
  assert.equal((await call('POST', '/api/me/two-step/enable', { code: '000000' }, adminCookie)).status, 400);
  const on = await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(adminSecret, twoStep.currentStep()) }, adminCookie);
  assert.equal(on.status, 200);
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.match(on.body.recoveryCodes[0], /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(on.body.user.twoStep.on, true);
  adminRecovery = on.body.recoveryCodes;
  assert.equal((await call('POST', '/api/me/two-step/start', null, adminCookie)).status, 409);
  assert.equal((await call('GET', '/api/admin/users', null, adminCookie)).status, 200);
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8'));
  assert.ok(!JSON.stringify(db).includes(adminRecovery[0]), 'recovery codes are stored hashed');
});

test('login checks the password, then the code', async () => {
  assert.equal((await call('POST', '/api/login', { username: 'raven', password: 'wrong pass' })).status, 401);
  const first = await call('POST', '/api/login', { username: 'RAVEN', password: 'correct horse' });
  assert.equal(first.status, 200);
  assert.equal(first.cookie, null);
  assert.equal(first.body.twoStep, true);
  const wrong = await call('POST', '/api/login/code', { ticket: first.body.ticket, code: '123456' });
  assert.equal(wrong.status, 400);
  const ok = await call('POST', '/api/login/code', { ticket: first.body.ticket, code: freshCode(adminSecret) });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal(ok.body.user.username, 'raven');
  // A ticket works once.
  assert.equal((await call('POST', '/api/login/code', { ticket: first.body.ticket, code: freshCode(adminSecret) })).status, 401);
});

test('the same code is refused twice', async () => {
  const again = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' });
  const res = await call('POST', '/api/login/code', { ticket: again.body.ticket, code: freshCode(adminSecret) });
  assert.equal(res.status, 400);
});

test('a recovery code works once and a trusted device skips the code', async () => {
  const first = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' });
  const ok = await call('POST', '/api/login/code', { ticket: first.body.ticket, code: adminRecovery[0].toUpperCase(), trust: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.twoStep.recoveryLeft, 9);
  const trust = ok.headers.find((c) => c.startsWith('roost_trust='));
  assert.ok(trust);
  const reuse = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' });
  assert.equal((await call('POST', '/api/login/code', { ticket: reuse.body.ticket, code: adminRecovery[0] })).status, 400);
  const trusted = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' }, trust);
  assert.equal(trusted.status, 200);
  assert.ok(trusted.cookie);
  assert.equal(trusted.body.user.username, 'raven');
  const status = await call('GET', '/api/me/two-step', null, adminCookie);
  assert.equal(status.body.trustedDevices, 1);
  await call('POST', '/api/me/two-step/forget-devices', null, adminCookie);
  const forgotten = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' }, trust);
  assert.equal(forgotten.body.twoStep, true);
});

test('too many wrong codes ends the sign-in', async () => {
  const first = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' });
  for (let i = 0; i < 4; i++) await call('POST', '/api/login/code', { ticket: first.body.ticket, code: '000000' });
  const last = await call('POST', '/api/login/code', { ticket: first.body.ticket, code: '000000' });
  assert.equal(last.status, 401);
  assert.equal((await call('POST', '/api/login/code', { ticket: first.body.ticket, code: freshCode(adminSecret) })).status, 401);
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

test('admins post a notice everyone sees until it ends or is cleared', async () => {
  assert.equal((await call('PUT', '/api/admin/notice', { text: 'Hi' }, userCookie)).status, 403);
  assert.equal((await call('GET', '/api/system', null, userCookie)).body.notice, null);
  const past = await call('PUT', '/api/admin/notice', { text: 'Old', until: new Date(Date.now() - 1000).toISOString() }, adminCookie);
  assert.equal(past.status, 400);

  const until = new Date(Date.now() + 3600 * 1000).toISOString();
  const posted = await call('PUT', '/api/admin/notice', { text: '  Maintenance tonight at 10pm  ', until }, adminCookie);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.notice.text, 'Maintenance tonight at 10pm');
  assert.equal(posted.body.notice.until, until);
  const seen = (await call('GET', '/api/system', null, userCookie)).body.notice;
  assert.equal(seen.text, 'Maintenance tonight at 10pm');

  const cleared = await call('PUT', '/api/admin/notice', { text: '' }, adminCookie);
  assert.equal(cleared.body.notice, null);
  assert.equal((await call('GET', '/api/system', null, userCookie)).body.notice, null);
});

test('an expired notice is no longer shown', async () => {
  await call('PUT', '/api/admin/notice', { text: 'Soon gone', until: new Date(Date.now() + 300).toISOString() }, adminCookie);
  assert.equal((await call('GET', '/api/system', null, userCookie)).body.notice.text, 'Soon gone');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call('GET', '/api/system', null, userCookie)).body.notice, null);
  await call('PUT', '/api/admin/notice', { text: '' }, adminCookie);
});

test('other users are offered two-step once, and admins can reset it', async () => {
  const state = await call('GET', '/api/state', null, userCookie);
  assert.deepEqual(
    { required: state.body.user.twoStep.required, offer: state.body.user.twoStep.offer },
    { required: false, offer: true });
  const skipped = await call('POST', '/api/me/two-step/skip', null, userCookie);
  assert.equal(skipped.body.user.twoStep.offer, false);
  const start = await call('POST', '/api/me/two-step/start', null, userCookie);
  await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(start.body.secret, twoStep.currentStep()) }, userCookie);
  assert.equal((await call('POST', '/api/login', { username: 'guest', password: 'guest pass 1' })).body.twoStep, true);
  assert.equal((await call('PATCH', `/api/admin/users/${userId}`, { resetTwoStep: true }, userCookie)).status, 403);
  const reset = await call('PATCH', `/api/admin/users/${userId}`, { resetTwoStep: true }, adminCookie);
  assert.equal(reset.body.user.twoStep.on, false);
  const back = await call('POST', '/api/login', { username: 'guest', password: 'guest pass 1' });
  assert.ok(back.cookie);
  userCookie = back.cookie;
});

test('turning two-step off needs the password', async () => {
  const start = await call('POST', '/api/me/two-step/start', null, userCookie);
  await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(start.body.secret, twoStep.currentStep()) }, userCookie);
  assert.equal((await call('POST', '/api/me/two-step/disable', { password: 'nope' }, userCookie)).status, 400);
  const off = await call('POST', '/api/me/two-step/disable', { password: 'guest pass 1' }, userCookie);
  assert.equal(off.body.user.twoStep.on, false);
});

test('admins can stop requiring two-step for admins', async () => {
  const off = await call('PATCH', '/api/admin/settings', { adminsNeedTwoStep: false }, adminCookie);
  assert.equal(off.body.settings.adminsNeedTwoStep, false);
  const on = await call('PATCH', '/api/admin/settings', { adminsNeedTwoStep: true }, adminCookie);
  assert.equal(on.body.settings.adminsNeedTwoStep, true);
  assert.equal((await call('GET', '/api/admin/settings', null, adminCookie)).body.settings.adminsNeedTwoStep, true);
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

test('status reports unset and built-in apps without probing', async () => {
  const { body } = await call('GET', '/api/apps/status', null, userCookie);
  // Glint is part of Roost, so it is up whenever Roost is.
  assert.equal(body.status.glint, 'online');
  assert.ok(['online', 'offline'].includes(body.status.jellyfin));
  const admin = await call('GET', '/api/apps/status', null, adminCookie);
  assert.equal(admin.body.status.nova, 'unset');
});

test('status page needs a signed-in user', async () => {
  assert.equal((await call('GET', '/api/status')).status, 401);
});

test('status reports server health and app states', async () => {
  const { status, body } = await call('GET', '/api/status', null, userCookie);
  assert.equal(status, 200);
  assert.ok(body.uptime > 0);
  assert.ok(body.cpu.cores > 0);
  assert.ok(body.cpu.percent >= 0 && body.cpu.percent <= 100);
  assert.ok(body.memory.total > 0 && body.memory.available <= body.memory.total);
  assert.ok(body.disks.length >= 1);
  assert.ok(body.disks[0].total > 0);
  // The guest only sees the apps they were given.
  assert.deepEqual(body.apps.map((a) => a.id), ['roost', 'jellyfin', 'glint']);
  assert.equal(body.apps[2].web.state, 'online');
  assert.ok(['online', 'offline'].includes(body.apps[1].web.state));
  // Without Docker it says so and only the web check is used.
  assert.equal(body.docker.ok, false);
  assert.deepEqual(body.apps[1].containers, []);
  assert.deepEqual(body.otherContainers, []);
  // Uptime history: Roost's own row from the start, and only the guest's apps.
  assert.ok(body.history.apps.roost.watched.length >= 1);
  assert.ok(Object.keys(body.history.apps).every((id) => ['roost', 'jellyfin', 'glint'].includes(id)));
});

test('ROOST_DISKS parsing skips bad entries', () => {
  const { parseDisks, readDisks } = require('../src/status');
  assert.deepEqual(parseDisks('System=/;Data = /data ;junk;=x'), [
    { label: 'System', path: '/' },
    { label: 'Data', path: '/data' },
  ]);
  const disks = readDisks([{ label: 'A', path: dataDir }, { label: 'B', path: dataDir }, { label: 'C', path: '/no/such/drive' }]);
  assert.deepEqual(disks.map((d) => d.label), ['A', 'C']);
  assert.equal(disks[1].missing, true);
});

test('users can rename themselves and change password', async () => {
  const renamed = await call('PATCH', '/api/me', { displayName: 'Guest Room' }, userCookie);
  assert.equal(renamed.body.user.displayName, 'Guest Room');
  const wrong = await call('PATCH', '/api/me', { currentPassword: 'nope', newPassword: 'new pass 123' }, userCookie);
  assert.equal(wrong.status, 400);
  const ok = await call('PATCH', '/api/me', { currentPassword: 'guest pass 1', newPassword: 'new pass 123' }, userCookie);
  assert.equal(ok.status, 200);
});

test('each user keeps their own app order and favourites', async () => {
  const { apps } = (await call('GET', '/api/apps', null, adminCookie)).body;
  const ids = apps.map((a) => a.id);
  const order = [...ids].reverse();
  const saved = await call('PATCH', '/api/me', { appOrder: [...order, 'gone', order[0]], favourites: [ids[1], 'gone'] }, adminCookie);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.user.appOrder, order);
  assert.deepEqual(saved.body.user.favourites, [ids[1]]);
  // The shared app list (and other people's layouts) stay as they were.
  assert.deepEqual((await call('GET', '/api/apps', null, adminCookie)).body.apps.map((a) => a.id), ids);
  assert.deepEqual((await call('GET', '/api/state', null, userCookie)).body.user.favourites, []);
  assert.equal((await call('PATCH', '/api/me', { favourites: 'nest' }, adminCookie)).status, 400);
});

test('new users get the default storage limit; the first admin has none', async () => {
  const mine = await call('GET', '/api/me/storage', null, userCookie);
  assert.equal(mine.body.storage.limitGb, 50);
  assert.equal(mine.body.storage.usedBytes, 0);
  const admin = await call('GET', '/api/me/storage', null, adminCookie);
  assert.equal(admin.body.storage.limitGb, null);
});

test('only admins can change a storage limit', async () => {
  await call('PATCH', '/api/me', { limitGb: 5000 }, userCookie);
  assert.equal((await call('GET', '/api/me/storage', null, userCookie)).body.storage.limitGb, 50);
  assert.equal((await call('PATCH', `/api/admin/users/${userId}`, { limitGb: 60 }, userCookie)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/users/${userId}`, { limitGb: 1.5 }, adminCookie)).status, 400);
  const ok = await call('PATCH', `/api/admin/users/${userId}`, { limitGb: 60 }, adminCookie);
  assert.equal(ok.body.user.storage.limitGb, 60);
});

test('admins can change the default for new users', async () => {
  const res = await call('PATCH', '/api/admin/settings', { defaultLimitGb: 25 }, adminCookie);
  assert.equal(res.body.settings.defaultLimitGb, 25);
  const made = await call('POST', '/api/admin/users', { username: 'kid', password: 'kid pass 12' }, adminCookie);
  assert.equal(made.body.user.storage.limitGb, 25);
  await call('DELETE', `/api/admin/users/${made.body.user.id}`, null, adminCookie);
});

test('users can request more storage and admins approve it', async () => {
  assert.equal((await call('POST', '/api/me/storage-requests', { requestedGb: 40 }, userCookie)).status, 400);
  const sent = await call('POST', '/api/me/storage-requests', { requestedGb: 200, note: 'Holiday photos' }, userCookie);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.request.status, 'pending');
  assert.equal((await call('POST', '/api/me/storage-requests', { requestedGb: 300 }, userCookie)).status, 409);
  assert.equal((await call('GET', '/api/admin/storage-requests', null, userCookie)).status, 403);
  const { body } = await call('GET', '/api/admin/storage-requests', null, adminCookie);
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].user.username, 'guest');
  const id = body.requests[0].id;
  assert.equal((await call('POST', `/api/admin/storage-requests/${id}`, { action: 'approve' }, userCookie)).status, 403);
  const ok = await call('POST', `/api/admin/storage-requests/${id}`, { action: 'approve', limitGb: 150 }, adminCookie);
  assert.equal(ok.body.request.status, 'approved');
  assert.equal((await call('POST', `/api/admin/storage-requests/${id}`, { action: 'decline' }, adminCookie)).status, 409);
  const mine = await call('GET', '/api/me/storage', null, userCookie);
  assert.equal(mine.body.storage.limitGb, 150);
  assert.equal(mine.body.requests[0].status, 'approved');
});

test('admins can decline a request', async () => {
  const sent = await call('POST', '/api/me/storage-requests', { requestedGb: 500 }, userCookie);
  const res = await call('POST', `/api/admin/storage-requests/${sent.body.request.id}`, { action: 'decline', reply: 'Drive is full' }, adminCookie);
  assert.equal(res.body.request.status, 'declined');
  const mine = await call('GET', '/api/me/storage', null, userCookie);
  assert.equal(mine.body.storage.limitGb, 150);
  assert.equal(mine.body.requests[0].reply, 'Drive is full');
});

test('storage apps need the app token to read limits and report usage', async () => {
  assert.equal((await call('GET', '/api/storage/users/guest')).status, 401);
  assert.equal((await call('GET', '/api/storage/users/guest', null, userCookie)).status, 401);
  const headers = { Authorization: 'Bearer app-secret', 'Content-Type': 'application/json' };
  const put = await fetch(`${base}/api/storage/users/guest/usage`, { method: 'PUT', headers, body: JSON.stringify({ app: 'nest', bytes: 1024 ** 3 }) });
  assert.equal(put.status, 200);
  const bad = await fetch(`${base}/api/storage/users/guest/usage`, { method: 'PUT', headers, body: JSON.stringify({ app: 'jellyfin', bytes: 1 }) });
  assert.equal(bad.status, 400);
  const got = await (await fetch(`${base}/api/storage/users/guest`, { headers })).json();
  assert.equal(got.storage.usedBytes, 1024 ** 3);
  assert.equal(got.storage.remainingBytes, 149 * 1024 ** 3);
  assert.equal((await call('GET', '/api/me/storage', null, userCookie)).body.storage.usage.nest, 1024 ** 3);
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function withKey(method, url, key) {
  const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('changing your password signs out your other devices', async () => {
  const other = (await call('POST', '/api/login', { username: 'guest', password: 'new pass 123' })).cookie;
  const ok = await call('PATCH', '/api/me', { currentPassword: 'new pass 123', newPassword: 'guest pass 1' }, userCookie);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/apps', null, other)).status, 401);
  assert.equal((await call('GET', '/api/apps', null, userCookie)).status, 200);
});

test('signed-in devices are listed by name and can be signed out', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': IPHONE },
    body: JSON.stringify({ username: 'guest', password: 'guest pass 1' }),
  });
  const phone = res.headers.getSetCookie()[0].split(';')[0];
  const { body } = await call('GET', '/api/me/devices', null, userCookie);
  assert.equal(body.devices.length, 2);
  const iphone = body.devices.find((d) => d.name === 'Safari on iPhone');
  assert.equal(iphone.current, false);
  assert.equal(body.devices.find((d) => d.current).kind, 'browser');
  assert.equal(body.devices.some((d) => 'hash' in d), false);
  assert.equal((await call('DELETE', `/api/me/devices/${iphone.id}`, null, userCookie)).status, 200);
  assert.equal((await call('GET', '/api/apps', null, phone)).status, 401);
  assert.equal((await call('DELETE', `/api/me/devices/${iphone.id}`, null, userCookie)).status, 404);
});

test('sign out everywhere else keeps this device', async () => {
  const other = (await call('POST', '/api/login', { username: 'guest', password: 'guest pass 1' })).cookie;
  assert.equal((await call('POST', '/api/me/devices/sign-out-others', null, userCookie)).status, 200);
  assert.equal((await call('GET', '/api/apps', null, other)).status, 401);
  const { body } = await call('GET', '/api/me/devices', null, userCookie);
  assert.equal(body.devices.length, 1);
});

test('apps on a phone sign in with a device key', async () => {
  const res = await call('POST', '/api/login', { username: 'guest', password: 'guest pass 1', device: "Guest's phone" });
  assert.equal(res.cookie, null);
  assert.match(res.body.key, /^[0-9a-f]{64}$/);
  const apps = await withKey('GET', '/api/apps', res.body.key);
  assert.deepEqual(apps.body.apps.map((a) => a.id), ['jellyfin', 'glint']);
  const { body } = await call('GET', '/api/me/devices', null, userCookie);
  const key = body.devices.find((d) => d.kind === 'app');
  assert.equal(key.name, "Guest's phone");
  assert.equal((await withKey('POST', '/api/logout', res.body.key)).status, 200);
  assert.equal((await withKey('GET', '/api/apps', res.body.key)).status, 401);
});

test('device keys go through two-step sign-in too', async () => {
  const { body } = await call('GET', '/api/admin/users', null, adminCookie);
  assert.ok(body.users.find((u) => u.username === 'raven').twoStep.on);
  const first = await call('POST', '/api/login', { username: 'raven', password: 'correct horse', device: 'Raven phone' });
  assert.equal(first.body.twoStep, true);
  const done = await call('POST', '/api/login/code', { ticket: first.body.ticket, code: adminRecovery.at(-1), trust: true });
  assert.equal(done.status, 200);
  assert.ok(done.body.key);
  assert.deepEqual(done.headers, []);
});

test('apps check who is signed in and whether they may use the app', async () => {
  assert.equal((await call('GET', '/api/auth/check?app=glint')).status, 401);
  const ok = await call('GET', '/api/auth/check?app=glint', null, userCookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'guest');
  assert.equal(ok.body.user.password, undefined);
  assert.equal((await call('GET', '/api/auth/check?app=nest', null, userCookie)).status, 403);
  assert.equal((await call('GET', '/api/auth/check?app=nest', null, adminCookie)).status, 200);
});

test('sign-ins survive a restart and only token hashes are saved', async () => {
  const saved = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  assert.equal(saved.includes(userCookie.split('=')[1]), false);
  const again = createServer({ dataDir });
  await new Promise((r) => again.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${again.address().port}/api/apps`, { headers: { Cookie: userCookie } });
    assert.equal(res.status, 200);
  } finally {
    again.close();
  }
});

test('the device name comes from the browser', () => {
  const { deviceName } = require('../src/auth');
  assert.equal(deviceName(IPHONE), 'Safari on iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'), 'Edge on Windows');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceName(''), 'Unknown browser');
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

test('repeated wrong passwords are slowed down', async () => {
  const { RateLimiter } = require('../src/auth');
  const limiter = new RateLimiter(2);
  assert.equal(limiter.allow('ip'), true);
  limiter.fail('ip');
  limiter.fail('ip');
  assert.equal(limiter.allow('ip'), false);
  assert.equal(limiter.allow('other'), true);
});

test('static files cannot escape the public folder', async () => {
  const res = await fetch(base + '/..%2fsrc%2fserver.js');
  assert.equal(res.status, 404);
});

test('activity log records sign-ins, failures and admin changes', async () => {
  const { status, body } = await call('GET', '/api/admin/activity', null, adminCookie);
  assert.equal(status, 200);
  const types = body.entries.map((e) => e.type);
  for (const t of ['setup', 'sign-in', 'sign-in-failed', 'user-added', 'user-changed', 'user-removed', 'storage-requested', 'storage-approved', 'storage-declined', 'settings-changed', 'password-changed']) {
    assert.ok(types.includes(t), `missing ${t}`);
  }
  // Newest first.
  assert.ok(body.entries[0].seq > body.entries[body.entries.length - 1].seq);
  const failed = body.entries.find((e) => e.type === 'sign-in-failed' && e.target === 'raven' && e.detail === 'wrong password');
  assert.ok(failed);
  assert.ok(body.entries.some((e) => e.type === 'sign-in-failed' && e.detail === 'wrong two-step code'));
  assert.ok(types.includes('two-step-on'));
  assert.equal(failed.kind, 'failed');
  // Without the proxy setting a forwarded header is ignored.
  assert.equal(failed.ip, '127.0.0.1');
  assert.doesNotMatch(JSON.stringify(body), /"wrong pass"|correct horse|new pass 123|scrypt/, 'passwords are never logged');
  const limit = body.entries.find((e) => e.type === 'user-changed' && /limit/.test(e.detail));
  assert.equal(limit.actor, 'raven');
});

test('activity log filters and is admins only', async () => {
  const { body } = await call('GET', '/api/admin/activity?filter=storage', null, adminCookie);
  assert.ok(body.entries.length > 0);
  assert.ok(body.entries.every((e) => e.kind === 'storage'));
  assert.equal((await call('GET', '/api/admin/activity')).status, 401);
});

test('activity log pages, reads the proxy address when told to, and survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-activity-'));
  const start = async () => {
    const srv = createServer({ dataDir: dir, trustProxy: true, activitySaveDelayMs: 60000 });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return [srv, `http://127.0.0.1:${srv.address().port}`];
  };
  let [s2, url] = await start();
  const post = (p, body, headers = {}) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const setup = await post('/api/setup', { username: 'raven', password: 'correct horse' });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const call2 = async (method, p, body, c) => {
      const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json', Cookie: c }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const secret = await setUpTwoStep(call2, cookie);
    for (let i = 0; i < 55; i++) {
      // Earlier X-Forwarded-For entries can be faked; the proxy's own one is last.
      await post('/api/login', { username: 'mia', password: 'guess guess' }, { 'X-Forwarded-For': `6.6.6.6, 10.0.0.${i}` });
    }
    const get = async (q) => (await fetch(`${url}/api/admin/activity${q}`, { headers: { Cookie: cookie } })).json();
    const first = await get('?filter=failed');
    assert.equal(first.entries.length, 50);
    assert.equal(first.more, true);
    assert.equal(first.entries[0].ip, '10.0.0.54');
    assert.equal(first.entries[0].detail, 'no such user');
    const second = await get(`?filter=failed&before=${first.entries[49].seq}`);
    assert.equal(second.entries.length, 5);
    assert.equal(second.more, false);
    s2.flushAll();
    s2.close();
    [s2, url] = await start();
    const { ticket } = await (await post('/api/login', { username: 'raven', password: 'correct horse' })).json();
    const login = await post('/api/login/code', { ticket, code: freshCode(secret) });
    const again = await (await fetch(`${url}/api/admin/activity`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })).json();
    assert.equal(again.entries[0].type, 'sign-in');
    assert.equal(again.entries[1].ip, '10.0.0.54');
    assert.ok(again.entries[0].seq > again.entries[1].seq);
  } finally {
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity log keeps only the newest entries', () => {
  const { ActivityLog } = require('../src/activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-cap-'));
  try {
    const log = new ActivityLog(dir, { max: 3 });
    for (let i = 0; i < 5; i++) log.add('sign-in', { actor: `u${i}` });
    log.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'));
    assert.deepEqual(saved.entries.map((e) => e.actor), ['u2', 'u3', 'u4']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logout ends the session', async () => {
  await call('POST', '/api/logout', null, adminCookie);
  assert.equal((await call('GET', '/api/apps', null, adminCookie)).status, 401);
});

test('status reads container state from Docker', async () => {
  const http = require('http');
  const containers = [
    { Id: 'aaa111', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin', State: 'running', Labels: {} },
    { Id: 'bbb222', Names: ['/nova-app'], Image: 'nova', State: 'exited', Labels: { 'com.docker.compose.project': 'nova' } },
    { Id: 'ccc333', Names: ['/roost'], Image: 'roost', State: 'running', Labels: {} },
    { Id: 'ddd444', Names: ['/tailscale'], Image: 'tailscale', State: 'running', Labels: {} },
  ];
  const inspect = {
    aaa111: { State: { Status: 'running', Running: true, StartedAt: '2026-10-07T10:00:00Z', Health: { Status: 'healthy' } }, RestartCount: 2 },
    bbb222: { State: { Status: 'exited', Running: false, ExitCode: 1, FinishedAt: '2026-10-07T11:00:00Z' }, RestartCount: 0 },
  };
  const fake = http.createServer((req, res) => {
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify(containers));
    const m = req.url.match(/^\/containers\/(\w+)\/json$/);
    if (m && inspect[m[1]]) return res.end(JSON.stringify(inspect[m[1]]));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-docker-'));
  const s2 = createServer({ dataDir: dir, probeTimeoutMs: 300, dockerHost: `tcp://127.0.0.1:${fake.address().port}` });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${s2.address().port}`;
    const setup = await fetch(url + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'raven', password: 'correct horse' }),
    });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const body = await (await fetch(url + '/api/status', { headers: { Cookie: cookie } })).json();
    assert.equal(body.docker.ok, true);
    const byId = Object.fromEntries(body.apps.map((a) => [a.id, a]));
    assert.deepEqual(byId.roost.containers.map((c) => c.name), ['roost']);
    assert.equal(byId.jellyfin.containers[0].health, 'healthy');
    assert.equal(byId.jellyfin.containers[0].restarts, 2);
    assert.equal(byId.nova.containers[0].state, 'exited');
    assert.equal(byId.nova.containers[0].exitCode, 1);
    assert.deepEqual(byId.nest.containers, []);
    assert.deepEqual(body.otherContainers.map((c) => c.name), ['tailscale']);
  } finally {
    s2.close();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('Roost can be installed as an app', async () => {
  const res = await fetch(base + '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of [...m.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const r = await fetch(base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control'), /max-age/);
    const png = Buffer.from(await r.arrayBuffer());
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h], icon.src);
  }
  for (const file of ['/sw.js', '/offline.html']) {
    const r = await fetch(base + file);
    assert.equal(r.status, 200, file);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
});
