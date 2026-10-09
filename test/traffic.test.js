'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createServer } = require('../src/server');
const { TrafficMeter, isHome, dayKey } = require('../src/traffic');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-traffic-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Raw request, so compressed bodies and headers come back untouched.
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('home and away addresses', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.20.1.1', '127.0.0.1', '::1', 'fd12::1', 'fe80::1']) assert.ok(isHome(ip), ip);
  // Tailscale (100.64.0.0/10) still crosses the home upload.
  for (const ip of ['100.101.5.6', '8.8.8.8', '172.32.0.1', '2a00:1450::1']) assert.ok(!isHome(ip), ip);
});

test('the page points at versioned files, which are kept for a year', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-cache');
  const m = page.body.toString().match(/src="\/app\.js\?v=([\w-]+)"/);
  assert.ok(m, 'app.js is versioned');
  assert.match(page.body.toString(), /href="\/style\.css\?v=[\w-]+"/);

  const js = await get(`/app.js?v=${m[1]}`);
  assert.match(js.headers['cache-control'], /max-age=31536000, immutable/);
  // An old version is not kept for a year.
  assert.equal((await get('/app.js?v=old')).headers['cache-control'], 'no-cache');
});

test('unchanged files answer 304, text is compressed', async () => {
  const css = await get('/style.css');
  const again = await get('/style.css', { 'If-None-Match': css.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const br = await get('/style.css', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), css.body);
  assert.ok(br.body.length < css.body.length / 2);
  const gz = await get('/style.css', { 'Accept-Encoding': 'gzip' });
  assert.deepEqual(zlib.gunzipSync(gz.body), css.body);

  assert.equal((await get('/nope.js')).status, 404);
});

test('admins see what was sent away from home', async () => {
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'raven', password: 'correct horse' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body, c) => {
    const res = await fetch(base + url, { method, headers: { Cookie: c, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  await setUpTwoStep(call, cookie);
  const s = await call('GET', '/api/status', null, cookie);
  // These tests run on 127.0.0.1, which is home.
  assert.deepEqual(s.body.traffic.apps.roost || { today: 0, week: 0 }, { today: 0, week: 0 });
  const meter = (await call('GET', '/api/admin/setup', null, cookie)).body.steps.find((x) => x.id === 'upload-meter');
  assert.equal(meter.done, false);
});

test('the meter adds up days and forgets old ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-meter-'));
  const m = new TrafficMeter(dir);
  const now = new Date(2026, 9, 8, 12);
  m.add('nest', 'away', 1000, dayKey(now));
  m.add('nest', 'home', 5000, dayKey(now));
  m.add('nest', 'away', 500, dayKey(new Date(2026, 9, 5)));
  m.add('nest', 'away', 9999, dayKey(new Date(2026, 8, 1)));
  assert.deepEqual(m.summary(now).apps.nest, { today: 1000, week: 1500 });
  for (let i = 0; i < 40; i++) m.add('roost', 'away', 1, dayKey(new Date(2026, 6, 1 + i)));
  m.flush();
  const saved = new TrafficMeter(dir);
  assert.equal(Object.keys(saved.days).length, 31);
  assert.deepEqual(saved.summary(now).apps.nest, { today: 1000, week: 1500 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requests from away are counted against the home upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-away-'));
  const s = createServer({ dataDir: dir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', trustProxy: true });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/style.css`;
  const res = await fetch(url, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  const size = (await res.arrayBuffer()).byteLength;
  await fetch(url, { headers: { 'X-Forwarded-For': '192.168.1.9' } }).then((r) => r.arrayBuffer());
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
  const day = JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8')).days[dayKey()];
  // fetch asks for compression, so less than the file's full size left home.
  assert.ok(day.roost.away > 0 && day.roost.away < size, String(day.roost.away));
  assert.ok(day.roost.home > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
