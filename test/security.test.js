'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { AccountGuard, SecurityWatch, securityChecks, isPrivateIp } = require('../src/security');
const { setUpTwoStep } = require('./helpers');

test('home network addresses are recognised', () => {
  for (const ip of ['192.168.4.35', '10.0.0.2', '172.16.5.1', '127.0.0.1', '::1', '::ffff:192.168.1.5', 'fd12::1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['87.114.78.169', '172.32.0.1', '8.8.8.8', '', undefined]) assert.equal(isPrivateIp(ip), false, String(ip));
});

test('the account guard pauses an account from outside, never from home', () => {
  let t = 1000;
  const guard = new AccountGuard({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) guard.fail('raven');
  assert.equal(guard.allow('raven', '87.114.78.169'), false);
  assert.equal(guard.allow('raven', '192.168.4.20'), true);
  assert.equal(guard.allow('dana', '87.114.78.169'), true);
  // Over HTTPS (the only way in from outside) a home-looking address may just be the router.
  assert.equal(guard.allow('raven', '192.168.4.20', true), false);
  t += 1500;
  assert.equal(guard.allow('raven', '87.114.78.169'), true);
  guard.fail('raven');
  guard.clear('raven');
  assert.equal(guard.recent('raven').length, 0);
});

function watch(users) {
  const db = { users, settings: {}, alerts: [] };
  const pushed = [];
  let n = 0;
  const w = new SecurityWatch({ store: { db, save() {} }, push: { alert: (kind, a) => pushed.push([kind, a.title]) }, newId: () => `id${++n}`, now: () => 1e12 });
  return { w, db, pushed };
}

const admin = { id: 'u1', username: 'raven', role: 'admin' };

test('repeated failed sign-ins on one account raise one alert', () => {
  const { w, db, pushed } = watch([admin]);
  for (let i = 0; i < 4; i++) w.onActivity('sign-in-failed', { target: 'raven', detail: 'wrong password' });
  assert.equal(db.alerts.length, 0);
  w.onActivity('sign-in-failed', { target: 'raven', detail: 'wrong password' });
  w.onActivity('sign-in-failed', { target: 'raven', detail: 'wrong password' });
  assert.equal(db.alerts.length, 1);
  assert.equal(pushed.length, 1);
  assert.match(db.alerts[0].title, /5 failed sign-ins for raven/);
  assert.equal(db.alerts[0].security, true);
});

test('guest passes ending are not counted as guessing', () => {
  const { w, db } = watch([admin]);
  for (let i = 0; i < 9; i++) w.onActivity('sign-in-failed', { target: 'raven', detail: 'guest pass ended' });
  assert.equal(db.alerts.length, 0);
});

test('an admin on a new device is flagged, the first one is not', () => {
  const { w, db, pushed } = watch([admin]);
  assert.equal(w.adminDevice(admin, 'Chrome on Windows', '1.2.3.4'), true);
  assert.equal(pushed.length, 0);
  assert.equal(w.adminDevice(admin, 'Chrome on Windows', '1.2.3.4'), false);
  assert.equal(w.adminDevice(admin, 'Safari on iPhone', '5.6.7.8'), true);
  assert.equal(pushed.length, 1);
  assert.match(db.alerts[0].detail, /Safari on iPhone · 5.6.7.8/);
  assert.equal(w.adminDevice({ id: 'u2', username: 'dana', role: 'member' }, 'Firefox', '1.1.1.1'), false);
});

test('changes to admin accounts raise alerts, changes to others do not', () => {
  const dana = { id: 'u2', username: 'dana', role: 'member' };
  const { w, db } = watch([admin, dana]);
  w.onActivity('password-changed', { actor: 'dana', target: 'dana' });
  w.onActivity('two-step-off', { actor: 'dana', target: 'dana' });
  assert.equal(db.alerts.length, 0);
  w.onActivity('password-changed', { actor: 'raven', target: 'raven' });
  w.onActivity('two-step-off', { actor: 'raven', target: 'raven' });
  w.onActivity('user-added', { actor: 'raven', target: 'sam', detail: 'admin, 5 GB' });
  w.onActivity('user-added', { actor: 'raven', target: 'kim', detail: 'member, 5 GB' });
  w.onActivity('user-changed', { actor: 'raven', target: 'dana', detail: 'role member → admin' });
  assert.equal(db.alerts.length, 4);
});

test('the switch turns security alerts off, and old ones fade after a day', () => {
  const { w, db } = watch([admin]);
  db.settings.alertSecurity = false;
  w.onActivity('password-changed', { actor: 'raven', target: 'raven' });
  assert.equal(db.alerts.length, 0);
  db.settings.alertSecurity = true;
  w.onActivity('password-changed', { actor: 'raven', target: 'raven' });
  assert.equal(db.alerts[0].resolvedAt, null);
  assert.equal(w.tidy(1e12 + 25 * 3600 * 1000), true);
  assert.ok(db.alerts[0].resolvedAt);
});

const base = { db: { users: [admin], settings: {} }, now: Date.parse('2026-10-26T12:00:00Z'), updates: { checked: true, update: 0, restart: 0 }, backup: { state: 'ok' }, pushDevices: 1 };

test('the checklist says all is well when it is', () => {
  const out = securityChecks({ ...base, db: { users: [{ ...admin, twoStep: {} }], settings: {} } });
  assert.equal(out.status, 'ok');
  assert.equal(out.headline, 'Everything looks safe');
});

test('an update waiting a long time turns the checklist red', () => {
  const find = (waitingDays) => securityChecks({ ...base, updates: { checked: true, update: 1, restart: 0, waitingDays } }).checks.find((c) => c.id === 'updates');
  assert.equal(find(0).status, 'warn');
  assert.match(find(9).title, /the oldest for 9 days/);
  assert.equal(find(9).status, 'warn');
  assert.equal(find(30).status, 'bad');
});

test('the checklist reports the backup test', () => {
  const at = '2026-10-20T03:00:00Z';
  const find = (backupTest, state = 'ok') => securityChecks({ ...base, backup: { state }, backupTest }).checks.find((c) => c.id === 'backup-test');
  assert.equal(find({ ok: true, checked: 20, bad: [], at }).status, 'ok');
  assert.equal(find({ ok: false, checked: 20, bad: ['Nest/a.jpg'], at }).status, 'bad');
  assert.equal(find(null).status, 'info');
  assert.equal(find(null, 'off'), undefined);
});

test('the checklist names what needs doing', () => {
  const out = securityChecks({
    ...base,
    db: { users: [admin, { id: 'u2', username: 'dana', role: 'member' }], settings: {} },
    outside: true,
    cert: { state: 'ready', daysLeft: 10 },
    updates: { checked: true, update: 2, restart: 0 },
    backup: { state: 'off' },
    pushDevices: 0,
    entries: Array.from({ length: 6 }, () => ({ type: 'sign-in-failed', at: '2026-10-26T10:00:00Z' })),
  });
  const by = Object.fromEntries(out.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(by, { 'admin-two-step': 'bad', 'member-two-step': 'warn', https: 'bad', updates: 'warn', backup: 'warn', failed: 'warn', phone: 'warn', ports: 'info', sentinel: 'ok' });
  assert.equal(out.status, 'bad');
  assert.equal(out.headline, '7 things need you');
});

// ---------- through the server ----------

let server;
let url;
let dataDir;
let cookie;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-security-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', trustProxy: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  cookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, cookie);
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, route, body, ck, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (ck) h.Cookie = ck;
  const res = await fetch(url + route, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: set && set.split(';')[0] };
}

test('the security page is for admins', async () => {
  assert.equal((await call('GET', '/api/admin/security')).status, 401);
  const { status, body } = await call('GET', '/api/admin/security', null, cookie);
  assert.equal(status, 200);
  assert.ok(body.checks.length >= 5);
  assert.equal(body.checks.find((c) => c.id === 'admin-two-step').status, 'ok');
});

test('guessing one account from outside gets it paused, and raises an alert', async () => {
  const away = { 'X-Forwarded-For': '87.114.78.169' };
  // The per-address limiter is 10, the account guard 8: vary the address.
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/login', { username: 'raven', password: 'nope' }, null, { 'X-Forwarded-For': `87.114.78.${i + 1}` });
    assert.equal(r.status, 401);
  }
  const locked = await call('POST', '/api/login', { username: 'raven', password: 'correct horse' }, null, away);
  assert.equal(locked.status, 429);
  const alerts = (await call('GET', '/api/alerts', null, cookie)).body;
  assert.ok(alerts.active.some((a) => a.security && /failed sign-ins for raven/.test(a.title)));
  assert.equal(alerts.settings.alertSecurity, true);
});

test('lockdown signs others out, blocks outside (HTTPS) traffic, and lifts at home', async () => {
  const { execFileSync } = require('child_process');
  const https = require('https');
  const tls = require('tls');
  const dana = (await call('POST', '/api/admin/users', { username: 'dana', password: 'another horse', role: 'member' }, cookie));
  assert.equal(dana.status, 201);
  const danaCookie = (await call('POST', '/api/login', { username: 'dana', password: 'another horse' })).cookie;
  assert.equal((await call('GET', '/api/state', null, danaCookie)).body.user.username, 'dana');

  assert.equal((await call('POST', '/api/admin/lockdown', { on: true }, cookie)).status, 200);
  assert.equal((await call('GET', '/api/state', null, danaCookie)).body.user, null);
  assert.equal((await call('GET', '/api/state', null, cookie)).body.user.username, 'raven');
  const view = (await call('GET', '/api/admin/security', null, cookie)).body;
  assert.ok(view.lockdown && view.checks.some((c) => c.id === 'lockdown'));
  assert.ok((await call('GET', '/api/alerts', null, cookie)).body.active.some((a) => a.key === 'sec:lockdown'));

  // The HTTPS side (where outside traffic arrives) answers 503 until it is lifted.
  const key = path.join(dataDir, 'k.pem');
  const crt = path.join(dataDir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  server.certs.context = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
  const secure = server.createHttpsServer();
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  const get = () => new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: secure.address().port, path: '/api/alerts', rejectUnauthorized: false, agent: false, servername: 'localhost' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(await get(), 503);
  assert.equal((await call('POST', '/api/admin/lockdown', { on: false }, cookie)).status, 200);
  assert.equal(await get(), 401);
  secure.closeAllConnections();
  secure.close();
});

test('Roost pages only run scripts from Roost, and ask for no camera or location', async () => {
  const res = await fetch(`${url}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(res.headers.get('strict-transport-security'), null); // plain HTTP at home
  const index = await res.text();
  assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts, which the policy would block');
  assert.doesNotMatch(index, /\son\w+="/, 'no inline event handlers');
});
