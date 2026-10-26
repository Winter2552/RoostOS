'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { createServer } = require('../src/server');
const { Sentinel, isScannerRequest, fingerprint, buildReport, redactPath } = require('../src/sentinel');
const { isPrivateIp } = require('../src/security');
const { setUpTwoStep } = require('./helpers');

test('scanner requests are told apart from Roost\'s own', () => {
  for (const u of ['/.env', '/.git/config', '/wp-login.php', '/phpmyadmin/index.php', '/cgi-bin/x', '/a/../../etc/passwd', '/x%2e%2e/y', '/boaform/admin/formLogin?x=1']) assert.equal(isScannerRequest(u), true, u);
  for (const u of ['/', '/api/state', '/.well-known/immich', '/s/abc123', '/api/nest/files?path=a.b', '/jellyfin/web/index.html', '/style.css?v=1']) assert.equal(isScannerRequest(u), false, u);
});

function make(mode, db = { users: [{ id: 'u1', username: 'raven', role: 'admin', password: 'x' }], settings: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sentinel-'));
  let t = 1e12;
  const raised = [];
  const locked = [];
  const s = new Sentinel({ dataDir: dir, store: { db }, raise: (k, title, detail) => raised.push({ k, title, detail }), lockdown: (by) => locked.push(by), skip: isPrivateIp, now: () => t, newId: (() => { let n = 0; return () => `i${++n}`; })() });
  s.setMode(mode);
  return { s, db, dir, raised, locked, tick: (ms) => { t += ms; } };
}

test('manual mode alerts and waits; auto mode bans at once', () => {
  const m = make('manual');
  for (let i = 0; i < 3; i++) m.s.request('87.1.1.1', '/.env');
  assert.equal(m.raised.length, 1);
  assert.equal(m.s.isBanned('87.1.1.1'), false);
  assert.equal(m.s.view().incidents[0].handled, null);
  m.s.ban('87.1.1.1', 'scanner'); // the Ban button
  assert.equal(m.s.isBanned('87.1.1.1'), true);
  assert.equal(m.s.view().incidents[0].handled, 'banned');

  const a = make('auto');
  for (let i = 0; i < 3; i++) a.s.request('87.2.2.2', '/wp-login.php');
  assert.equal(a.s.isBanned('87.2.2.2'), true);
  assert.match(a.raised[0].detail, /banned that address for 24 hours/);
  assert.deepEqual(a.locked, []);
});

test('two probes are noise, ten minutes apart they never add up', () => {
  const m = make('auto');
  m.s.request('87.1.1.1', '/.env');
  m.s.request('87.1.1.1', '/.git/config');
  m.tick(11 * 60 * 1000);
  m.s.request('87.1.1.1', '/wp-login.php');
  assert.equal(m.raised.length, 0);
});

test('guessing many usernames is spotted', () => {
  const m = make('auto');
  for (const n of ['admin', 'root', 'test']) m.s.failedSignIn('87.3.3.3', n);
  assert.equal(m.raised.length, 0);
  m.s.failedSignIn('87.3.3.3', 'raven');
  m.s.failedSignIn('87.3.3.3', 'dana');
  assert.equal(m.raised.length, 1);
  assert.equal(m.s.isBanned('87.3.3.3'), true);
});

test('home addresses are never banned, and off means off', () => {
  const m = make('auto');
  assert.equal(m.s.ban('192.168.4.20', 'x'), false);
  for (let i = 0; i < 5; i++) m.s.request('192.168.4.20', '/.env');
  assert.equal(m.s.isBanned('192.168.4.20'), false);
  // Still noticed (outside traffic can look like a home address behind a second router).
  assert.equal(m.raised.length, 1);
  assert.match(m.raised[0].detail, /not banned/);
  m.raised.length = 0;
  m.s.ban('87.4.4.4', 'x');
  m.s.setMode('off');
  assert.equal(m.s.isBanned('87.4.4.4'), false);
  m.s.request('87.5.5.5', '/.env'); m.s.request('87.5.5.5', '/.env'); m.s.request('87.5.5.5', '/.env');
  assert.equal(m.raised.length, 0);
});

test('admin accounts changed behind Roost\'s back raise an alarm; Roost\'s own changes do not', async () => {
  const m = make('manual');
  m.s.checkSeal(); // first look: just seals
  assert.equal(m.raised.length, 0);
  m.db.users.push({ id: 'u2', username: 'sneaky', role: 'admin', password: 'y' });
  m.s.checkSeal();
  assert.equal(m.raised.length, 1);
  assert.equal(m.raised[0].title, 'Admin accounts were changed behind Roost');
  assert.deepEqual(m.locked, []); // manual: you decide
  m.s.checkSeal();
  assert.equal(m.raised.length, 1); // one alert per change

  m.db.users.push({ id: 'u3', username: 'dana', role: 'admin', password: 'z' });
  m.s.reseal(); // a Roost screen did it
  await new Promise((r) => setTimeout(r, 1700));
  m.s.checkSeal();
  assert.equal(m.raised.length, 1);

  const a = make('auto');
  a.s.checkSeal();
  a.db.users[0].password = 'changed';
  a.s.checkSeal();
  assert.deepEqual(a.locked, ['Sentinel']);
});

test('state survives a restart, expired bans do not', () => {
  const m = make('auto');
  m.s.ban('87.6.6.6', 'x');
  m.s.checkSeal();
  m.s.flush();
  const again = new Sentinel({ dataDir: m.dir, store: { db: m.db }, now: () => 1e12 + 1000 });
  assert.equal(again.mode, 'auto');
  assert.equal(again.bans.length, 1);
  assert.equal(again.seal, fingerprint(m.db));
  const later = new Sentinel({ dataDir: m.dir, store: { db: m.db }, now: () => 1e12 + 25 * 3600 * 1000 });
  assert.equal(later.bans.length, 0);
});

test('reports keep the path but not the query or link tokens', () => {
  assert.equal(redactPath('/s/AbCdEfGhIjKlMnOpQrStUv?download=1&token=secret'), '/s/…');
  assert.equal(redactPath('/api/nest/files?path=private%20name'), '/api/nest/files');
  assert.equal(redactPath('/wp-login.php'), '/wp-login.php');
});

test('an incident keeps its evidence and makes a report without secrets', () => {
  const db = { users: [{ id: 'u1', username: 'raven', role: 'admin', password: 'scrypt:salt:hash', twoStep: { secret: 'TOPSECRET' } }], settings: { lockdown: { at: 'x', by: 'Sentinel' } } };
  const m = make('manual', db);
  for (const p of ['/', '/.env?x=1', '/.git/config', '/wp-login.php']) { const e = m.s.trace('87.1.1.1', 'GET', p, 'curl/8'); e.status = 404; m.s.request('87.1.1.1', p); }
  m.s.trace('87.2.2.2', 'GET', '/other', 'x');
  const inc = m.s.view().incidents[0];
  assert.equal(inc.report, true);
  assert.equal(inc.evidence, undefined, 'the list stays small; evidence is only in the report');
  const text = buildReport({ incident: m.s.incidents[0], entries: [{ at: new Date(1e12).toISOString(), type: 'sign-in-failed', actor: null, target: 'raven', detail: 'wrong password', ip: '87.1.1.1' }], users: db.users, settings: db.settings, version: '0.1.13', mode: 'manual', bans: [] });
  assert.match(text, /# Roost incident report/);
  assert.match(text, /\/\.git\/config \| 404 \| curl\/8/);
  assert.doesNotMatch(text, /\/other/); // another address's request
  assert.doesNotMatch(text, /x=1/); // the query is gone
  assert.match(text, /sign-in-failed/);
  assert.doesNotMatch(text, /scrypt|TOPSECRET/);
  assert.match(text, /raven \| admin \| on/);

  for (let i = 0; i < 12; i++) m.s.incident('spray', `87.9.9.${i}`, 'x');
  assert.equal(m.s.view().incidents.filter((i) => i.report).length, 10, 'only the latest ten keep evidence');
});

// ---------- through the server ----------

test('outside (HTTPS) scanners are banned in auto mode, and the admin can see and lift it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sentinel-srv-'));
  const server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', trustProxy: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: set && set.split(';')[0] };
  };
  const key = path.join(dataDir, 'k.pem');
  const crt = path.join(dataDir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  server.certs.context = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
  const secure = server.createHttpsServer();
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  const get = (p, ip) => new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: secure.address().port, path: p, rejectUnauthorized: false, agent: false, servername: 'localhost', headers: { 'X-Forwarded-For': ip } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  try {
    assert.equal((await call('GET', '/api/admin/sentinel')).status, 401);
    const cookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, cookie);
    const view = (await call('GET', '/api/admin/sentinel', null, cookie)).body;
    assert.equal(view.mode, 'manual');
    assert.equal((await call('PUT', '/api/admin/sentinel', { mode: 'loud' }, cookie)).status, 400);

    // Manual: three probes raise an incident, the address still gets through.
    for (let i = 0; i < 3; i++) await get('/.env', '87.9.9.9');
    let v = (await call('GET', '/api/admin/sentinel', null, cookie)).body;
    assert.equal(v.incidents.length, 1);
    assert.equal(await get('/api/state', '87.9.9.9'), 200);
    // The Ban button.
    v = (await call('POST', '/api/admin/sentinel/ban', { incident: v.incidents[0].id }, cookie)).body;
    assert.equal(v.bans[0].ip, '87.9.9.9');
    assert.equal(await get('/api/state', '87.9.9.9'), 403);
    assert.equal(await get('/api/state', '87.8.8.8'), 200);
    // Plain HTTP (home) is never blocked, even for a banned address.
    const plain = await fetch(`${base}/api/state`, { headers: { 'X-Forwarded-For': '87.9.9.9' } });
    assert.equal(plain.status, 200);
    // A home address can't be banned.
    assert.equal((await call('POST', '/api/admin/sentinel/ban', { ip: '192.168.1.5' }, cookie)).status, 400);
    // Unban.
    assert.equal((await call('POST', '/api/admin/sentinel/unban', { ip: '87.9.9.9' }, cookie)).body.bans.length, 0);
    assert.equal(await get('/api/state', '87.9.9.9'), 200);

    // Auto: bans on its own, and shows on the Security checklist.
    await call('PUT', '/api/admin/sentinel', { mode: 'auto' }, cookie);
    for (let i = 0; i < 3; i++) await get('/wp-login.php', '87.7.7.7');
    assert.equal(await get('/api/state', '87.7.7.9'), 200);
    assert.equal(await get('/api/state', '87.7.7.7'), 403);
    const checks = (await call('GET', '/api/admin/security', null, cookie)).body.checks;
    assert.equal(checks.find((c) => c.id === 'sentinel').title, 'Sentinel is on and acts on its own');
    assert.ok((await call('GET', '/api/alerts', null, cookie)).body.active.some((a) => /scanner is probing Roost: 87.7.7.7/i.test(a.title)));

    // The report for that incident: admins only, a download, evidence from the outside requests.
    const inc = (await call('GET', '/api/admin/sentinel', null, cookie)).body.incidents.find((i) => i.ip === '87.7.7.7');
    assert.equal(inc.report, true);
    assert.equal((await fetch(`${base}/api/admin/sentinel/report?incident=${inc.id}`)).status, 401);
    const rep = await fetch(`${base}/api/admin/sentinel/report?incident=${inc.id}`, { headers: { Cookie: cookie } });
    assert.equal(rep.status, 200);
    assert.match(rep.headers.get('content-disposition'), /attachment; filename="roost-incident-.*scanner\.md"/);
    const text = await rep.text();
    assert.match(text, /\/wp-login\.php/);
    assert.match(text, /87\.7\.7\.7/);
    assert.doesNotMatch(text, /scrypt:/);
    assert.equal((await fetch(`${base}/api/admin/sentinel/report?incident=nope`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    secure.closeAllConnections();
    secure.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
