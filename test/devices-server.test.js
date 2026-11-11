'use strict';

// The Device finder is Raven's alone: his account, from the house.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

let dir;
let lan;
let server;
let tunnel;
let raven;
let boss;
let kim;
let n = 0;

function ask(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, body: json }); });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const call = (method, url, body, cookie) => ask(server.address().port, method, url, { body, headers: cookie ? { Cookie: cookie } : {} });
const outside = (method, url, cookie) => ask(tunnel.address().port, method, url, { headers: { 'cf-connecting-ip': '198.51.100.9', Cookie: cookie } });
const cookieOf = (r) => r.headers['set-cookie'][0].split(';')[0];

const router = { ip: '192.168.4.1', mac: 'b0:a7:37:00:00:01', ports: [80], mdns: null, dns: 'router' };
const self = { ip: '192.168.4.35', mac: 'b8:27:eb:00:00:35', ports: [8080], mdns: null, dns: null };
const camera = { ip: '192.168.4.47', mac: 'c0:56:e3:00:00:47', ports: [23, 80], mdns: null, dns: null };

function sweep(hosts) {
  n++;
  const file = path.join(lan, 'lan.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date(Date.now() + n * 1000).toISOString(), every: 1800000, gateway: router.ip, self: self.ip, hosts }));
  fs.utimesSync(file, new Date(Date.now() + n * 1000), new Date(Date.now() + n * 1000));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-devices-server-'));
  lan = path.join(dir, 'lan');
  fs.mkdirSync(lan);
  server = createServer({ dataDir: dir, lanDir: lan, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', sendMail: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tunnel = server.createTunnelServer();
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  raven = cookieOf(await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' }));
  await setUpTwoStep(call, raven);
  await call('POST', '/api/admin/users', { username: 'boss', password: 'boss pass 12', role: 'admin' }, raven);
  await call('POST', '/api/admin/users', { username: 'kim', password: 'kim pass 123' }, raven);
  boss = cookieOf(await call('POST', '/api/login', { username: 'boss', password: 'boss pass 12' }));
  await setUpTwoStep(call, boss);
  kim = cookieOf(await call('POST', '/api/login', { username: 'kim', password: 'kim pass 123' }));
});

after(async () => {
  tunnel.closeAllConnections();
  server.closeAllConnections();
  await new Promise((r) => tunnel.close(r));
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the first admin sees it, and only from home; everyone else gets "not found"', async () => {
  sweep([router, self]);
  assert.equal((await call('GET', '/api/admin/devices', null, raven)).status, 200);
  assert.equal((await call('GET', '/api/admin/devices/available', null, raven)).status, 200);
  for (const who of [boss, kim, undefined]) {
    for (const [method, url] of [['GET', '/api/admin/devices'], ['GET', '/api/admin/devices/available'], ['POST', '/api/admin/devices/scan'], ['POST', '/api/admin/devices/known-all'], ['PUT', '/api/admin/devices/rules'], ['PATCH', '/api/admin/devices/b0-a7-37-00-00-01'], ['DELETE', '/api/admin/devices/b0-a7-37-00-00-01']]) {
      assert.equal((await call(method, url, ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined, who)).status, 404, `${method} ${url}`);
    }
  }
  // Raven's own sign-in, used from outside the house, shows nothing.
  assert.equal((await outside('GET', '/api/admin/devices', raven)).status, 404);
  assert.equal((await call('GET', '/api/admin/devices', null, raven)).status, 200);
});

test('the list, naming, and the first-sweep baseline', async () => {
  let v = (await call('GET', '/api/admin/devices', null, raven)).body;
  assert.equal(v.baselined, false);
  assert.equal(v.devices.length, 2);
  v = (await call('POST', '/api/admin/devices/known-all', {}, raven)).body;
  assert.equal(v.baselined, true);
  const named = await call('PATCH', `/api/admin/devices/${router.mac.replace(/:/g, '-')}`, { label: 'Hall router', type: 'router', tag: 'other' }, raven);
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.devices.find((d) => d.mac === router.mac).name, 'Hall router');
  assert.equal((await call('PATCH', `/api/admin/devices/${router.mac.replace(/:/g, '-')}`, { type: 'toaster' }, raven)).status, 400);
  assert.equal((await call('PATCH', '/api/admin/devices/aa-aa-aa-aa-aa-aa', { label: 'x' }, raven)).status, 404);
});

test('a new device’s alert reaches Raven’s bell and no one else’s', async () => {
  await call('PUT', '/api/admin/devices/rules', { riskyPorts: true }, raven);
  sweep([router, self, camera]);
  await call('GET', '/api/admin/devices', null, raven);
  sweep([router, self, camera]);
  await call('GET', '/api/admin/devices', null, raven);
  const mine = (await call('GET', '/api/alerts', null, raven)).body.active.map((a) => a.title);
  assert.ok(mine.includes('New device on your network'), mine.join('|'));
  assert.ok(mine.some((t) => /Telnet/.test(t)));
  const theirs = (await call('GET', '/api/alerts', null, boss)).body.active;
  assert.deepEqual(theirs.filter((a) => /dev:/.test(a.key)), []);
  const id = (await call('GET', '/api/alerts', null, raven)).body.active.find((a) => /dev:new/.test(a.key)).id;
  assert.equal((await call('POST', `/api/alerts/${id}/dismiss`, {}, boss)).status, 404);
  assert.equal((await call('POST', `/api/alerts/${id}/dismiss`, {}, raven)).status, 200);
});

test('risky-port findings appear in Sentinel’s list for Raven only', async () => {
  const mine = (await call('GET', '/api/admin/sentinel', null, raven)).body.incidents;
  assert.ok(mine.some((i) => i.kind === 'device'));
  const theirs = (await call('GET', '/api/admin/sentinel', null, boss)).body.incidents;
  assert.equal(theirs.some((i) => i.kind === 'device'), false);
});

test('its setup step is for the owner only', async () => {
  const has = async (cookie) => (await call('GET', '/api/admin/setup', null, cookie)).body.steps.some((s) => s.id === 'device-finder');
  assert.equal(await has(raven), true);
  assert.equal(await has(boss), false);
});

test('Scan now leaves the helper a note', async () => {
  assert.equal((await call('POST', '/api/admin/devices/scan', {}, raven)).body.requested, true);
  assert.ok(fs.existsSync(path.join(lan, 'scan-now')));
});
