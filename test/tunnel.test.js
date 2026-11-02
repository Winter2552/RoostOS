'use strict';

// The private port the Cloudflare Tunnel container hands visitors to.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

let dir;
let server;
let plain;
let tunnel;
let routeOn = false;
let admin;

function ask(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-tunnel-'));
  server = createServer({
    dataDir: dir,
    probeTimeoutMs: 200,
    dockerHost: 'tcp://127.0.0.1:1',
    remoteOptions: {
      getTls: () => ({ domain: 'roostos.network', token: 't' }),
      getSettings: () => ({ route: routeOn ? 'tunnel' : 'direct' }),
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tunnel = server.createTunnelServer();
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  plain = server.address().port;
});

after(async () => {
  tunnel.closeAllConnections();
  server.closeAllConnections();
  await new Promise((r) => tunnel.close(r));
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const viaTunnel = (method, url, opts = {}) => ask(tunnel.address().port, method, url, { ...opts, headers: { 'cf-connecting-ip': '198.51.100.9', ...(opts.headers || {}) } });
const direct = (method, url, opts) => ask(plain, method, url, opts);

test('a sign-in through the tunnel gets a Secure cookie, though the hop to Roost is plain HTTP', async () => {
  const made = await viaTunnel('POST', '/api/setup', { body: { username: 'raven', password: 'correct horse' } });
  assert.equal(made.status, 201);
  const set = made.headers['set-cookie'].join(';');
  assert.match(set, /Secure/);
  admin = made.headers['set-cookie'][0].split(';')[0];
  const call = async (method, url, body, cookie) => {
    const r = await direct(method, url, { body, headers: cookie ? { Cookie: cookie } : {} });
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* not JSON */ }
    return { status: r.status, body: parsed };
  };
  await setUpTwoStep(call, admin);
  // The domain the sign-in cookie can cover (saved, with no certificate asked for).
  assert.equal((await call('PUT', '/api/admin/tls', { domain: 'roostos.network', token: 'secret-token', renew: false }, admin)).status, 200);
  // The plain home port stays without Secure.
  const home = await direct('POST', '/api/login', { body: { username: 'raven', password: 'correct horse' } });
  assert.doesNotMatch((home.headers['set-cookie'] || []).join(';'), /Secure/);
});

test('Roostflix is handed to its direct name when asked for through the tunnel', async () => {
  // Direct route: no redirect to the stream name.
  const before = await viaTunnel('GET', '/jellyfin/');
  assert.doesNotMatch(String(before.headers.location || ''), /stream\./);
  routeOn = true;
  const redirected = await viaTunnel('GET', '/jellyfin/web/index.html?x=1');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.location, 'https://stream.roostos.network/jellyfin/web/index.html?x=1');
  assert.equal((await viaTunnel('POST', '/jellyfin/Sessions', { body: {} })).status, 421);
  // A signed-in visitor takes the sign-in with them: the cookie is re-issued for the whole domain.
  const signedIn = await viaTunnel('GET', '/jellyfin/', { headers: { Cookie: admin, Host: 'roostos.network' } });
  assert.equal(signedIn.status, 302);
  const cookies = (signedIn.headers['set-cookie'] || []).join('\n');
  assert.match(cookies, /Domain=roostos\.network/);
  assert.match(cookies, /Secure/);
  // Someone not signed in gets the redirect and no cookie.
  assert.equal((await viaTunnel('GET', '/jellyfin/', { headers: { Host: 'roostos.network' } })).headers['set-cookie'], undefined);
  // The home port is untouched.
  assert.doesNotMatch(String((await direct('GET', '/jellyfin/')).headers.location || ''), /stream\./);
  routeOn = false;
});

test('lockdown shuts the tunnel like the HTTPS port, and the home port still answers', async () => {
  const call = (method, url, body) => direct(method, url, { body, headers: { Cookie: admin } });
  assert.equal((await call('POST', '/api/admin/lockdown', { on: true })).status, 200);
  assert.equal((await viaTunnel('GET', '/api/remote/ping')).status, 503);
  assert.equal((await direct('GET', '/api/remote/ping')).status, 200);
  assert.equal((await call('POST', '/api/admin/lockdown', { on: false })).status, 200);
  assert.equal((await viaTunnel('GET', '/api/remote/ping')).status, 200);
});

test('the visitor address comes from Cloudflare\'s header on the tunnel port, and a forged one on the home port is ignored', async () => {
  await viaTunnel('POST', '/api/login', { body: { username: 'raven', password: 'wrong wrong wrong' } });
  await direct('POST', '/api/login', { body: { username: 'raven', password: 'wrong again' }, headers: { 'cf-connecting-ip': '203.0.113.99' } });
  const log = await direct('GET', '/api/admin/activity', { headers: { Cookie: admin } });
  const text = log.text;
  assert.match(text, /198\.51\.100\.9/);
  assert.doesNotMatch(text, /203\.0\.113\.99/);
});
