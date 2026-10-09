'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RemoteAccess, clean, isCloudflare, isHome, isCgnat } = require('../src/remote');
const { clientIp } = require('../src/activity');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

// A stand-in for the internet: the address lookup, Cloudflare's DNS API and
// Roost's own public address.
function fakeInternet({ ip = '203.0.113.7', records = [], nonce = () => '', pingStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    const reply = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (url.includes('cdn-cgi/trace')) return reply(200, `fl=1\nip=${ip}\nts=1\n`);
    if (url.includes('/zones?name=')) return reply(200, { success: true, result: [{ id: 'zone1' }] });
    if (url.includes('/dns_records?type=A')) return reply(200, { success: true, result: records });
    if (url.includes('/dns_records')) {
      const body = JSON.parse(init.body);
      const now = { id: 'rec1', ...body };
      records.splice(0, records.length, now);
      return reply(200, { success: true, result: now });
    }
    if (url.endsWith('/api/remote/ping')) return pingStatus === 200 ? reply(200, { nonce: nonce() }) : reply(pingStatus, {});
    throw new Error('fetch failed');
  };
  fn.calls = calls;
  fn.records = records;
  return fn;
}

function make({ settings = {}, tls = { domain: 'roostos.network', token: 't' }, ...net } = {}) {
  const state = { settings: { ...settings } };
  const fetchImpl = fakeInternet(net);
  const r = new RemoteAccess({
    getSettings: () => state.settings,
    patch: (f) => { state.settings = { ...state.settings, ...f }; },
    getTls: () => tls,
    fetchImpl,
    cloudflareApi: 'https://cf.test/v4',
  });
  return { r, state, fetchImpl };
}

const req = (ip, { encrypted = true, headers = {} } = {}) => ({ socket: { remoteAddress: ip, encrypted }, headers });

test('Cloudflare, home and shared-address ranges are recognised, including IPv6 forms', () => {
  assert.ok(isCloudflare('104.16.0.1') && isCloudflare('::ffff:104.16.0.1') && isCloudflare('2606:4700::1'));
  assert.ok(!isCloudflare('8.8.8.8') && !isCloudflare('') && !isCloudflare(undefined));
  assert.ok(isHome('192.168.1.20') && isHome('::ffff:10.0.0.2') && isHome('::1') && !isHome('8.8.8.8'));
  assert.ok(isCgnat('100.64.3.4') && isCgnat('100.127.255.255') && !isCgnat('100.128.0.1') && !isCgnat('203.0.113.7'));
});

test('a visitor address is only believed when the connection is Cloudflare\'s', () => {
  const { r } = make();
  assert.equal(r.visitor(req('104.16.0.1', { headers: { 'cf-connecting-ip': '198.51.100.9' } })), '198.51.100.9');
  assert.equal(r.visitor(req('8.8.8.8', { headers: { 'cf-connecting-ip': '198.51.100.9' } })), null);
  assert.equal(r.visitor(req('104.16.0.1', { headers: { 'cf-connecting-ip': 'not an ip' } })), null);
  // The activity log and rate limits read it from there.
  assert.equal(clientIp({ roostIp: '198.51.100.9', socket: { remoteAddress: '104.16.0.1' }, headers: {} }, false), '198.51.100.9');
});

test('Cloudflare-only turns away outside HTTPS traffic that skipped Cloudflare, but not home or Cloudflare', () => {
  const on = make({ settings: { cloudflareOnly: true } }).r;
  assert.equal(on.blocks(req('8.8.8.8')), true);
  assert.equal(on.blocks(req('104.16.0.1')), false);
  assert.equal(on.blocks(req('192.168.1.20')), false);
  assert.equal(on.blocks(req('::ffff:192.168.1.20')), false);
  // Plain HTTP is the home-network port, never refused.
  assert.equal(on.blocks(req('8.8.8.8', { encrypted: false })), false);
  assert.equal(make().r.blocks(req('8.8.8.8')), false);
});

test('only the two settings can be saved', () => {
  assert.deepEqual(clean({ ddns: true, cloudflareOnly: 'yes', other: 1 }), { ddns: true, cloudflareOnly: false });
});

test('the domain record is made, left alone while the address holds, and fixed when it moves', async () => {
  const net = { records: [] };
  const { r, state, fetchImpl } = make({ settings: { ddns: true }, ...net });
  const first = await r.sync();
  assert.deepEqual([first.ok, first.ip, first.changed, first.cgnat], [true, '203.0.113.7', true, false]);
  assert.equal(fetchImpl.records[0].type, 'A');
  assert.equal(fetchImpl.records[0].proxied, true);
  assert.equal(fetchImpl.records[0].name, 'roostos.network');

  // Same address, recently checked: no call to Cloudflare at all.
  const before = fetchImpl.calls.length;
  await r.sync();
  assert.equal(fetchImpl.calls.slice(before).filter((c) => c.includes('cf.test')).length, 0);

  // A forced check finds the record already right and changes nothing.
  assert.equal((await r.sync({ force: true })).changed, false);

  // The home address moves.
  const moved = make({ settings: { ddns: true }, ip: '203.0.113.99', records: [{ id: 'rec1', type: 'A', name: 'roostos.network', content: '203.0.113.7', proxied: true }] });
  const next = await moved.r.sync();
  assert.deepEqual([next.ok, next.ip, next.changed], [true, '203.0.113.99', true]);
  assert.equal(moved.fetchImpl.records[0].content, '203.0.113.99');
  assert.equal(state.settings.dns.ip, '203.0.113.7');
});

test('a shared (CGNAT) public address is flagged', async () => {
  const { r } = make({ settings: { ddns: true }, ip: '100.70.1.2' });
  assert.equal((await r.sync()).cgnat, true);
  assert.equal(r.view().cgnat, true);
});

test('without a saved domain and token it says what to do first', async () => {
  const { r } = make({ tls: {} });
  const out = await r.sync();
  assert.equal(out.ok, false);
  assert.match(out.error, /Secure connection/);
  assert.equal((await r.ping()).ok, false);
});

test('the route test passes only when this Roost answers', async () => {
  const good = make({ nonce: () => 'x' });
  good.fetchImpl = fakeInternet({ nonce: () => good.r.nonce });
  good.r.fetch = good.fetchImpl;
  const ok = await good.r.ping();
  assert.equal(ok.ok, true);
  assert.equal(good.state.settings.reach.ok, true);

  const other = make({ nonce: () => 'someone else' });
  const wrong = await other.r.ping();
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /isn’t this Roost/);

  const refused = make({ pingStatus: 522 });
  assert.match((await refused.r.ping()).error, /Full \(strict\)/);

  const down = make();
  down.r.fetch = async () => { throw new Error('fetch failed'); };
  assert.match((await down.r.ping()).error, /port 443/);
});

// ---------- through the server ----------

let server;
let base;
let dataDir;
let cookie;
const internet = fakeInternet({ nonce: () => server.remote.nonce });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-remote-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', remoteOptions: { fetchImpl: internet, cloudflareApi: 'https://cf.test/v4' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' });
  cookie = setup.cookie;
  await setUpTwoStep(call, cookie);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cook) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cook) headers.Cookie = cook;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

test('the ping needs no sign-in and gives away nothing but a code', async () => {
  const { status, body } = await call('GET', '/api/remote/ping');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['nonce']);
});

test('remote access settings are for admins only', async () => {
  assert.equal((await call('GET', '/api/admin/remote')).status, 401);
  assert.equal((await call('PUT', '/api/admin/remote', { ddns: true })).status, 401);
  assert.equal((await call('POST', '/api/admin/remote/check')).status, 401);
});

test('an admin saves the settings, checks the route, and the checklist follows', async () => {
  const step = async (id) => (await call('GET', '/api/admin/setup', null, cookie)).body.steps.find((s) => s.id === id).done;
  assert.equal(await step('remote-dns'), false);

  // The domain and token come from the HTTPS step.
  const tls = await call('PUT', '/api/admin/tls', { domain: 'roostos.network', token: 'secret-token', renew: false }, cookie);
  assert.equal(tls.status, 200);

  // Rewriting the live record needs an explicit yes.
  assert.equal((await call('PUT', '/api/admin/remote', { ddns: true, cloudflareOnly: false }, cookie)).status, 400);
  assert.equal(server.remote.settings().ddns, undefined);
  const saved = await call('PUT', '/api/admin/remote', { ddns: true, cloudflareOnly: false, confirmProxy: true }, cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ddns, true);

  const checked = await call('POST', '/api/admin/remote/check', null, cookie);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.dns.ok, true);
  assert.equal(checked.body.reach.ok, true);
  assert.equal(await step('remote-dns'), true);
  assert.equal(await step('remote-forward'), true);
  assert.equal(await step('remote-cloudflare-only'), false);

  await call('PUT', '/api/admin/remote', { ddns: true, cloudflareOnly: true }, cookie);
  assert.equal(await step('remote-cloudflare-only'), true);
});

test('the Cloudflare token never goes back to the browser', async () => {
  const { body } = await call('GET', '/api/admin/settings', null, cookie);
  assert.equal(JSON.stringify(body).includes('secret-token'), false);
});

test('saving the settings is written to the activity log', async () => {
  const { body } = await call('GET', '/api/admin/activity', null, cookie);
  assert.ok(JSON.stringify(body).includes('Remote access'));
});

// Drives the server's real request handler with a pretend HTTPS connection.
function handleAs(ip, headers = {}) {
  return new Promise((resolve) => {
    const out = { status: 0, body: '' };
    const res = {
      headersSent: false,
      setHeader() {},
      on() {},
      writeHead(status) { out.status = status; this.headersSent = true; },
      end(data) { out.body = String(data || ''); resolve(out); },
    };
    const request = { method: 'GET', url: '/api/remote/ping', headers, socket: { remoteAddress: ip, encrypted: true } };
    server.emit('request', request, res);
  });
}

test('with Cloudflare-only on, the server refuses a direct visit and lets Cloudflare and home through', async () => {
  await call('PUT', '/api/admin/remote', { ddns: false, cloudflareOnly: true }, cookie);
  const direct = await handleAs('8.8.8.8');
  assert.equal(direct.status, 403);
  assert.equal((await handleAs('104.16.0.1', { 'cf-connecting-ip': '198.51.100.9' })).status, 200);
  assert.equal((await handleAs('192.168.1.20')).status, 200);
  await call('PUT', '/api/admin/remote', { ddns: false, cloudflareOnly: false }, cookie);
  assert.equal((await handleAs('8.8.8.8')).status, 200);
});
