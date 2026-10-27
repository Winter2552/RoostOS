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
  assert.equal(m.raised.length, 0, 'mild probing is listed, not announced');
  assert.equal(m.s.isBanned('87.1.1.1'), false);
  assert.equal(m.s.view().incidents[0].handled, null);
  m.s.ban('87.1.1.1', 'scanner'); // the Ban button
  assert.equal(m.s.isBanned('87.1.1.1'), true);
  assert.equal(m.s.view().incidents[0].handled, 'banned');

  const a = make('auto');
  for (let i = 0; i < 3; i++) a.s.request('87.2.2.2', '/wp-login.php');
  assert.equal(a.s.isBanned('87.2.2.2'), true);
  assert.equal(a.s.view().incidents[0].handled, 'banned');
  assert.equal(a.raised.length, 0);
  assert.deepEqual(a.locked, []);
});

test('several addresses at once is an attack: one alert, and auto mode locks down', () => {
  const probe = (m) => {
    for (let n = 1; n <= 4; n++) for (let i = 0; i < 3; i++) m.s.request(`87.9.9.${n}`, '/.env');
    assert.equal(m.raised.length, 0, 'four addresses is still background noise');
    for (let i = 0; i < 3; i++) m.s.request('87.9.9.5', '/.env');
  };
  const man = make('manual');
  probe(man);
  assert.equal(man.raised.length, 1);
  assert.equal(man.raised[0].title, 'Many addresses are attacking Roost');
  assert.match(man.raised[0].detail, /5 different addresses/);
  assert.deepEqual(man.locked, []);
  for (let i = 0; i < 3; i++) man.s.request('87.9.9.6', '/.env');
  assert.equal(man.raised.length, 1, 'one alert per wave');

  const auto = make('auto');
  probe(auto);
  assert.deepEqual(auto.locked, ['Sentinel']);
  assert.match(auto.raised[0].detail, /Sentinel locked Roost down/);

  const slow = make('manual'); // five addresses spread over an hour is not a wave
  for (let n = 1; n <= 5; n++) { for (let i = 0; i < 3; i++) slow.s.request(`87.8.8.${n}`, '/.env'); slow.tick(15 * 60 * 1000); }
  assert.equal(slow.raised.length, 0);
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
  assert.equal(m.s.incidents.length, 1);
  assert.equal(m.s.incidents[0].kind, 'spray');
  assert.equal(m.raised.length, 0);
  assert.equal(m.s.isBanned('87.3.3.3'), true);
});

test('home addresses are never banned, and off means off', () => {
  const m = make('auto');
  assert.equal(m.s.ban('192.168.4.20', 'x'), false);
  for (let i = 0; i < 5; i++) m.s.request('192.168.4.20', '/.env');
  assert.equal(m.s.isBanned('192.168.4.20'), false);
  // Still noticed (outside traffic can look like a home address behind a second router).
  assert.equal(m.s.incidents.length, 1);
  assert.match(m.s.incidents[0].detail, /places that don't exist/);
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

test('a new container, or a changed image, is flagged until trusted', () => {
  const m = make('manual');
  const c = (name, imageRef) => ({ name, imageRef });
  m.s.containers([c('jellyfin', 'jellyfin/jellyfin:latest'), c('roost', 'roost-roost')]); // the baseline
  assert.equal(m.raised.length, 0);
  m.s.containers([c('jellyfin', 'jellyfin/jellyfin:latest'), c('roost', 'roost-roost'), c('roost-roost-run-1a2b3c', 'x')]); // a one-off
  assert.equal(m.raised.length, 0);
  m.s.containers([c('jellyfin', 'jellyfin/jellyfin:latest'), c('miner', 'evil/miner:latest')]);
  assert.equal(m.raised.length, 1);
  assert.match(m.raised[0].detail, /new container is running: miner \(evil\/miner:latest\)/);
  m.s.containers([c('miner', 'evil/miner:latest')]);
  assert.equal(m.raised.length, 1, 'once, not on every look');
  m.s.containers([c('jellyfin', 'someone/else:latest')]);
  assert.match(m.raised[1].detail, /jellyfin now runs a different image: jellyfin\/jellyfin:latest → someone\/else:latest/);
  const inc = m.s.incidents[0];
  assert.equal(m.s.view().incidents.find((i) => i.id === inc.id).canTrust, true);
  assert.equal(m.s.trust(inc), true);
  assert.equal(inc.handled, 'trusted');
  m.s.containers([c('miner', 'evil/miner:latest')]);
  assert.equal(m.raised.length, 2, 'trusted, so quiet');

  const off = make('off');
  off.s.containers([c('a', 'x')]);
  assert.equal(off.s.known, null);
});

test('a stolen sign-in is flagged once; auto mode signs it out', () => {
  const ended = [];
  const m = make('manual');
  m.s.endSession = (u, id) => ended.push([u, id]);
  const hit = { userId: 'u1', username: 'raven', sessionId: 's1', was: 'Safari on iPhone', now: 'Chrome on Windows', ip: '87.1.1.1' };
  assert.equal(m.s.sessionMismatch(hit), false);
  assert.equal(m.s.sessionMismatch(hit), false);
  assert.equal(m.raised.length, 1);
  assert.match(m.raised[0].detail, /made on Safari on iPhone, is being used from Chrome on Windows/);
  assert.deepEqual(ended, []);
  assert.equal(m.s.view().incidents[0].canEnd, true);

  const a = make('auto');
  a.s.endSession = (u, id) => ended.push([u, id]);
  assert.equal(a.s.sessionMismatch(hit), true);
  assert.deepEqual(ended, [['u1', 's1']]);
  assert.equal(a.s.isBanned('87.1.1.1'), true);
  assert.match(a.s.incidents[0].handled, /signed out/);
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
    assert.equal((await call('GET', '/api/alerts', null, cookie)).body.active.some((a) => /87.7.7.7/.test(a.title)), false, 'one scanner stays quiet');

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

    // A stolen sign-in: the admin's cookie (made over plain HTTP at home) turns up on the outside in another browser.
    await call('PUT', '/api/admin/sentinel', { mode: 'manual' }, cookie);
    const getAs = (p, ip, ua, ck) => new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: secure.address().port, path: p, rejectUnauthorized: false, agent: false, servername: 'localhost', headers: { 'X-Forwarded-For': ip, 'User-Agent': ua, Cookie: ck } }, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject));
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';
    const seenAs = (r) => JSON.parse(r.body).user;
    // The cookie from a session made by "node" (Unknown browser): same label, no alarm.
    assert.equal((seenAs(await getAs('/api/state', '87.5.5.5', 'node', cookie))).username, 'raven');
    assert.equal((await call('GET', '/api/admin/sentinel', null, cookie)).body.incidents.some((i) => i.kind === 'session'), false);
    // Manual: a different browser raises an incident but still gets in; Sign out ends it.
    assert.equal((seenAs(await getAs('/api/state', '87.5.5.6', chrome, cookie))).username, 'raven');
    const stolen = (await call('GET', '/api/admin/sentinel', null, cookie)).body.incidents.find((i) => i.kind === 'session');
    assert.equal(stolen.canEnd, true);
    assert.equal((await call('POST', '/api/admin/sentinel/end-session', { incident: stolen.id }, cookie)).status, 200);
    assert.equal(seenAs(await getAs('/api/state', '87.5.5.6', chrome, cookie)), null);
  } finally {
    secure.closeAllConnections();
    secure.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
