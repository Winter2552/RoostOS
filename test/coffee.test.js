'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Coffee, validSecret, newSecret, HELPER_PER_MINUTE } = require('../src/coffee');
const wireguard = require('../src/wireguard');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const SECRET = 'ab'.repeat(32);
const DOMAIN = 'roostos.network';

function gateway(over = {}) {
  return new Coffee({ getConfig: () => ({ enabled: true, secret: SECRET }), getDomain: () => DOMAIN, now: () => 1_700_000_000_000, ...over });
}

test('only /coffee exists, with the prefix stripped and a few paths left open', () => {
  const c = gateway();
  assert.equal(c.route('/chat'), null);
  assert.equal(c.route('/coffeehouse'), null);
  assert.deepEqual(c.route('/coffee/chat'), { path: '/chat', open: false, helper: false });
  assert.deepEqual(c.route('/coffee/'), { path: '/', open: false, helper: false });
  assert.equal(c.route('/coffee/__vanstock/helper').open, true);
  for (const p of ['/__health', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']) assert.equal(c.route(`/coffee${p}`).open, true, p);
  assert.equal(c.route('/coffee/__vanstock/other').open, false);
});

test('the signature is the HMAC of timestamp, user and admin flag, and bad names are refused', () => {
  const c = gateway();
  const id = c.identity('Mia', false);
  assert.equal(id['x-roost-user'], 'mia');
  assert.equal(id['x-roost-admin'], '0');
  assert.equal(id['x-roost-ts'], '1700000000');
  const expected = crypto.createHmac('sha256', SECRET).update('1700000000\nmia\n0').digest('hex');
  assert.equal(id['x-roost-sig'], expected);
  assert.equal(c.identity('root', true)['x-roost-admin'], '1');
  assert.equal(c.identity('bad name', false), null);
  assert.equal(c.identity('x'.repeat(41), false), null);
  assert.equal(c.identity('', false), null);
});

test('it only answers on the Coffee Galaxy address, and only when switched on', () => {
  const req = (host) => ({ headers: { host } });
  assert.equal(gateway().matches(req('nova.roostos.network')), true);
  assert.equal(gateway().matches(req('NOVA.roostos.network:443')), true);
  assert.equal(gateway().matches(req('roostos.network')), false);
  assert.equal(gateway().matches(req('nova.evil.example')), false);
  assert.equal(gateway({ getConfig: () => ({ enabled: false, secret: SECRET }) }).matches(req('nova.roostos.network')), false);
  assert.equal(gateway({ getConfig: () => ({ enabled: true, secret: '' }) }).matches(req('nova.roostos.network')), false);
});

test('the phone app endpoint is limited per address per minute', () => {
  let now = 1_700_000_000_000;
  const c = gateway({ now: () => now });
  for (let i = 0; i < HELPER_PER_MINUTE; i += 1) assert.equal(c.helperAllowed('1.2.3.4'), true);
  assert.equal(c.helperAllowed('1.2.3.4'), false);
  assert.equal(c.helperAllowed('5.6.7.8'), true);
  now += 60 * 1000;
  assert.equal(c.helperAllowed('1.2.3.4'), true);
});

test('secrets: made ones are valid, short or odd ones are not', () => {
  assert.equal(validSecret(newSecret()), true);
  assert.equal(validSecret('abc'), false);
  assert.equal(validSecret('z'.repeat(64)), false);
});

test('WireGuard keys match, the config points at the other server and nothing else', () => {
  const a = wireguard.makeKeys();
  assert.equal(wireguard.publicOf(a.privateKey), a.publicKey);
  assert.equal(wireguard.validKey(a.publicKey), true);
  assert.equal(wireguard.validKey('nope'), false);
  assert.equal(wireguard.cleanEndpoint('141.147.108.43'), '141.147.108.43:51820');
  assert.equal(wireguard.cleanEndpoint('vpn.example.com:7000'), 'vpn.example.com:7000');
  assert.equal(wireguard.cleanEndpoint('a b'), null);
  assert.equal(wireguard.cleanEndpoint('1.2.3.4:99999'), null);
  const b = wireguard.makeKeys();
  const text = wireguard.configText({ privateKey: a.privateKey, peerPublicKey: b.publicKey, endpoint: '141.147.108.43:51820' });
  assert.match(text, /Address = 10\.77\.0\.1\/24/);
  assert.match(text, new RegExp(`PublicKey = ${b.publicKey.replace(/[+/]/g, '\\$&')}`));
  assert.match(text, /AllowedIPs = 10\.77\.0\.2\/32/);
  assert.match(text, /PersistentKeepalive = 25/);
  assert.doesNotMatch(text, /ListenPort/);
});

test('the key file is made once, kept private, and the config is written with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-wg-'));
  const calls = [];
  const w = new wireguard.WireGuard(dir, { run: (cmd, args, opts, cb) => { calls.push([cmd, ...args].join(' ')); cb(null, '', ''); } });
  const pub = w.publicKey();
  assert.equal(w.publicKey(), pub);
  assert.equal(fs.statSync(w.keyFile).mode & 0o777, 0o600);
  const other = wireguard.makeKeys();
  w.write({ peerPublicKey: other.publicKey, endpoint: '1.2.3.4:51820' });
  assert.equal(fs.statSync(w.confFile).mode & 0o777, 0o600);
  assert.equal((await w.apply()).ok, true);
  assert.deepEqual(calls, [`wg-quick down ${w.confFile}`, `wg-quick up ${w.confFile}`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a container without wg-quick says what to do instead of failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-wg-'));
  const w = new wireguard.WireGuard(dir, { run: (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '', '') });
  w.write({ peerPublicKey: wireguard.makeKeys().publicKey, endpoint: '1.2.3.4:51820' });
  const out = await w.apply();
  assert.equal(out.ok, false);
  assert.match(out.note, /no WireGuard tools/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- through the server ----------

let server;
let upstream;
let base;
let dataDir;
let admin;
let seen = [];
const wgCalls = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/__health') return res.end('ok');
      if (req.url === '/big') { res.writeHead(200, { 'Content-Length': 3 * 1024 * 1024, 'Content-Type': 'image/png' }); return res.end(Buffer.alloc(3 * 1024 * 1024, 7)); }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'coffee=1; Path=/coffee' });
      res.end('hello from coffee');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-coffee-'));
  server = createServer({
    dataDir,
    probeTimeoutMs: 200,
    dockerHost: 'tcp://127.0.0.1:1',
    coffeeOptions: {
      target: `http://127.0.0.1:${upstream.address().port}`,
      wireguard: { run: (cmd, args, opts, cb) => { wgCalls.push(args[0]); cb(null, '', ''); } },
      fetchImpl: (url, init) => fetch(url, init),
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  await call('PUT', '/api/admin/tls', { domain: DOMAIN, token: 'tok', renew: false }, admin);
  await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', apps: ['nova'] }, admin);
  await call('POST', '/api/admin/users', { username: 'noa', password: 'password1', apps: ['jellyfin'] }, admin);
  await call('POST', '/api/admin/users', { username: 'pia', password: 'password1', role: 'guest', guestUntil: new Date(Date.now() + 86400000).toISOString(), apps: ['nova'] }, admin);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0], setCookie };
}

// A request that arrives for nova.roostos.network (fetch won't let a script set Host).
function nova(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers: { host: `nova.${DOMAIN}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const login = async (username) => (await call('POST', '/api/login', { username, password: 'password1' })).cookie;

test('the gateway is admin-only, and refuses to switch on without a secret or with a bad key', async () => {
  assert.equal((await call('GET', '/api/admin/coffee')).status, 401);
  assert.equal((await call('POST', '/api/admin/coffee/secret')).status, 401);
  const off = await call('GET', '/api/admin/coffee', null, admin);
  assert.equal(off.status, 200);
  assert.equal(wireguard.validKey(off.body.publicKey), true);
  assert.equal((await call('PUT', '/api/admin/coffee', { enabled: true }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/coffee', { peerPublicKey: 'junk' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/coffee', { endpoint: 'bad host' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/coffee', { secret: 'short' }, admin)).status, 400);
});

test('making a secret shows it once and it never comes back', async () => {
  const made = await call('POST', '/api/admin/coffee/secret', null, admin);
  assert.equal(validSecret(made.body.secret), true);
  assert.equal(made.body.secretSaved, true);
  const view = JSON.stringify((await call('GET', '/api/admin/coffee', null, admin)).body);
  assert.equal(view.includes(made.body.secret), false);
  assert.equal(JSON.stringify((await call('GET', '/api/admin/settings', null, admin)).body).includes(made.body.secret), false);
  server.secretForTest = made.body.secret;
});

test('saving links WireGuard to the other server and switches the gateway on', async () => {
  const peer = wireguard.makeKeys().publicKey;
  const saved = await call('PUT', '/api/admin/coffee', { peerPublicKey: peer, endpoint: '141.147.108.43', enabled: true }, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.endpoint, '141.147.108.43:51820');
  assert.deepEqual(wgCalls, ['down', 'up']);
  const conf = fs.readFileSync(path.join(dataDir, 'wireguard', 'wg0.conf'), 'utf8');
  assert.match(conf, /Endpoint = 141\.147\.108\.43:51820/);
  const checked = await call('POST', '/api/admin/coffee/check', null, admin);
  assert.equal(checked.body.check.ok, true);
});

test('the sign-in cookie covers the whole domain on that domain, and only there', async () => {
  const signIn = (host) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/login`, { method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0])); });
    req.on('error', reject);
    req.end(JSON.stringify({ username: 'mia', password: 'password1' }));
  });
  assert.match(await signIn(DOMAIN), new RegExp(`Domain=${DOMAIN}`));
  assert.doesNotMatch(await signIn('192.168.4.35'), /Domain=/);
  assert.doesNotMatch(await signIn('roostos.network.evil.example'), /Domain=/);
});

test('a signed-out browser is sent to Roost and back; an app call just gets 401', async () => {
  const page = await nova('/coffee/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, `https://${DOMAIN}/?next=coffee`);
  const before = seen.length;
  assert.equal((await nova('/coffee/chat', { headers: { accept: 'application/json' } })).status, 401);
  assert.equal(seen.length, before);
});

test('a signed-in person with the app gets through with a signed header, prefix stripped', async () => {
  const mia = await login('mia');
  const out = await nova('/coffee/chat?x=1', { headers: { cookie: `${mia}; other=1`, 'x-roost-user': 'root', 'x-roost-admin': '1', 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.toString(), 'hello from coffee');
  const got = seen.at(-1);
  assert.equal(got.url, '/chat?x=1');
  // Whatever the browser claimed is gone; Roost's signed version replaced it.
  assert.equal(got.headers['x-roost-user'], 'mia');
  assert.equal(got.headers['x-roost-admin'], '0');
  const secret = server.secretForTest;
  const expected = crypto.createHmac('sha256', secret).update(`${got.headers['x-roost-ts']}\nmia\n0`).digest('hex');
  assert.equal(got.headers['x-roost-sig'], expected);
  assert.notEqual(got.headers['x-forwarded-for'], '9.9.9.9');
  assert.equal(got.headers['x-forwarded-proto'], 'http');
  // Roost's own sign-in cookie stays home; other cookies pass.
  assert.equal(got.headers.cookie, 'other=1');
  assert.match(out.headers['set-cookie'][0], /coffee=1/);
});

test('an admin is marked admin; people without the app, and ended guest passes, are turned away', async () => {
  await nova('/coffee/who', { headers: { cookie: admin } });
  assert.equal(seen.at(-1).headers['x-roost-admin'], '1');
  assert.equal(seen.at(-1).headers['x-roost-user'], 'raven');

  const before = seen.length;
  assert.equal((await nova('/coffee/chat', { headers: { cookie: await login('noa') } })).status, 403);
  assert.equal(seen.length, before);

  const pia = await login('pia');
  assert.equal((await nova('/coffee/chat', { headers: { cookie: pia } })).status, 200);
  const users = (await call('GET', '/api/admin/users', null, admin)).body.users;
  await call('PATCH', `/api/admin/users/${users.find((u) => u.username === 'pia').id}`, { endGuestPass: true }, admin);
  assert.equal((await nova('/coffee/chat', { headers: { cookie: pia } })).status, 401);
});

test('the open paths work with no Roost sign-in and carry no identity', async () => {
  for (const p of ['/coffee/__health', '/coffee/manifest.webmanifest', '/coffee/icon-192.png', '/coffee/icon-512.png', '/coffee/__vanstock/helper']) {
    const out = await nova(p, { method: p.includes('helper') ? 'POST' : 'GET', headers: { 'x-roost-user': 'mia', 'x-roost-sig': 'forged' }, body: p.includes('helper') ? '{}' : undefined });
    assert.equal(out.status, 200, p);
    const got = seen.at(-1);
    assert.equal(got.headers['x-roost-user'], undefined, p);
    assert.equal(got.headers['x-roost-sig'], undefined, p);
  }
  assert.equal(seen.at(-1).body, '{}');
});

test('big answers stream through whole', async () => {
  const big = await nova('/coffee/big', { headers: { cookie: await login('mia') } });
  assert.equal(big.status, 200);
  assert.equal(big.body.length, 3 * 1024 * 1024);
  assert.equal(big.headers['content-length'], String(3 * 1024 * 1024));
});

test('only /coffee exists on that address, and the root goes there', async () => {
  const root = await nova('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/coffee/');
  assert.equal((await nova('/api/state')).status, 404);
  assert.equal((await nova('/jellyfin/')).status, 404);
});

test('an unreachable Coffee Galaxy server gives a plain 502', async () => {
  const mia = await login('mia');
  await new Promise((r) => upstream.close(r));
  const out = await nova('/coffee/chat', { headers: { cookie: mia } });
  assert.equal(out.status, 502);
  assert.match(out.body.toString(), /not answering/);
  upstream = http.createServer();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
});

test('the checklist follows the link check and the switch', async () => {
  const done = async (id) => (await call('GET', '/api/admin/setup', null, admin)).body.steps.find((s) => s.id === id).done;
  assert.equal(await done('coffee-gateway'), true);
});
