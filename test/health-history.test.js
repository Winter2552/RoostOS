'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HealthHistory, FINE_EVERY } = require('../src/health-history');
const { Watcher } = require('../src/alerts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-history-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-26T10:00:00Z');

test('only every fifth minute is kept, and empty readings are ignored', () => {
  const h = new HealthHistory(null);
  for (let m = 0; m < 12; m++) h.sample({ watts: 20, cpuTemp: 45, driveTemp: 38 }, T0 + m * MIN);
  assert.deepEqual(h.fine.map((p) => (p.t - T0) / MIN), [0, 5, 10]);
  h.sample({ watts: null, cpuTemp: null, driveTemp: null }, T0 + 15 * MIN);
  h.sample(null, T0 + 15 * MIN);
  assert.equal(h.fine.length, 3);
});

test('an hour closes into one averaged point with its peaks, and the file is written then', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'a-'));
  const h = new HealthHistory(dir);
  const watts = [10, 20, 30];
  watts.forEach((w, i) => h.sample({ watts: w, cpuTemp: 40 + i * 10, driveTemp: null }, T0 + i * FINE_EVERY));
  assert.equal(h.hourly.length, 0);
  assert.equal(fs.existsSync(h.file), false); // nothing written mid-hour
  h.sample({ watts: 40, cpuTemp: 50, driveTemp: null }, T0 + HOUR); // the next hour begins
  assert.deepEqual(h.hourly, [{ t: T0, w: 20, c: 50, d: null, wx: 30, cx: 60, dx: null }]);
  assert.equal(fs.existsSync(h.file), true);

  // The hour in progress survives a restart too.
  h.flush();
  const again = new HealthHistory(dir);
  assert.equal(again.hourly.length, 1);
  assert.equal(again.fine.length, 4);
  assert.ok(again.bucket && again.bucket.t === T0 + HOUR);
});

test('old points are dropped: 48 hours of fine, 90 days of hourly', () => {
  const h = new HealthHistory(null);
  h.sample({ watts: 10, cpuTemp: 40, driveTemp: null }, T0);
  h.sample({ watts: 10, cpuTemp: 40, driveTemp: null }, T0 + 49 * HOUR);
  assert.deepEqual(h.fine.map((p) => p.t), [T0 + 49 * HOUR]);
  h.hourly = [{ t: T0 - 100 * 24 * HOUR, w: 1 }, { t: T0 - 10 * 24 * HOUR, w: 2 }];
  h.sample({ watts: 10, cpuTemp: 40, driveTemp: null }, T0 + 51 * HOUR);
  h.sample({ watts: 10, cpuTemp: 40, driveTemp: null }, T0 + 53 * HOUR); // closes a bucket, which trims
  assert.ok(h.hourly.every((p) => p.t >= T0 + 49 * HOUR - 90 * 24 * HOUR));
  assert.equal(h.hourly.some((p) => p.w === 1), false);
});

test('series gives the points, peaks and energy for each range', () => {
  const h = new HealthHistory(null);
  // Two hours of 5-minute points at a steady 12 W.
  for (let i = 0; i < 24; i++) h.sample({ watts: 12, cpuTemp: 45 + (i === 3 ? 10 : 0), driveTemp: 40 }, T0 + i * FINE_EVERY);
  const day = h.series('day', T0 + 2 * HOUR);
  assert.equal(day.range, 'day');
  assert.equal(day.points.length, 24);
  assert.equal(day.peaks.c, 55);
  assert.equal(day.kwh, +((12 * 24 * (FINE_EVERY / HOUR)) / 1000).toFixed(2));

  const week = h.series('week', T0 + 2 * HOUR);
  assert.equal(week.points.length, 1); // one closed hour so far
  assert.equal(week.peaks.w, 12);
  assert.equal(h.series('nonsense', T0).range, 'day');
});

test('the watcher feeds the history on every check, and a broken sampler does not stop alerts', async () => {
  const samples = [];
  let n = 0;
  const store = { db: { settings: {}, apps: [], users: [] }, save() {} };
  const watcher = new Watcher({ store, readContainers: async () => ({ containers: [] }), readDisks: () => [], newId: () => `a${n++}`, sample: (t) => samples.push(t), now: () => 5 });
  await watcher.check();
  assert.deepEqual(samples, [5]);

  const broken = new Watcher({ store, readContainers: async () => ({ containers: [] }), readDisks: () => [], newId: () => 'x', sample: () => { throw new Error('boom'); } });
  const log = console.error;
  console.error = () => {};
  try {
    await broken.check();
  } finally {
    console.error = log;
  }
  assert.ok(broken.checkedAt);
});

test('the history route is for admins, and returns cost at the saved price', async () => {
  const { createServer } = require('../src/server');
  const { setUpTwoStep } = require('./helpers');
  const dataDir = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = { 'Content-Type': 'application/json' };
    const res = await fetch(`${base}/api/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'raven', password: 'correct horse' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body, c = cookie) => {
      const r = await fetch(base + url, { method, headers: { ...json, Cookie: c }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    await setUpTwoStep(call, cookie);
    const now = Date.now();
    for (let i = 0; i < 12; i++) server.healthHistory.sample({ watts: 100, cpuTemp: 50, driveTemp: 40 }, now - (12 - i) * FINE_EVERY);
    const out = await call('GET', '/api/admin/health-history?range=day');
    assert.equal(out.status, 200);
    assert.equal(out.body.points.length, 12);
    assert.equal(out.body.kwh, 0.1); // 100 W for an hour
    assert.equal(out.body.cost, '2.7p'); // at the default 26.84p
    assert.equal(out.body.peaks.c, 50);

    const anon = await fetch(`${base}/api/admin/health-history`);
    assert.ok([401, 403].includes(anon.status));
  } finally {
    server.close();
  }
});
