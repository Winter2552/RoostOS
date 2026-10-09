'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UptimeLog, DAY } = require('../src/uptime');

function clock(start) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('uptime log records outages and only writes on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-uptime-'));
  const c = clock(10 * DAY);
  const log = new UptimeLog(dir, { now: c.now });
  assert.strictEqual(log.observe('jellyfin', true), false);
  c.t += 60000;
  assert.strictEqual(log.observe('jellyfin', true), false);
  assert.strictEqual(log.observe('jellyfin', false), true);
  c.t += 14 * 60000;
  assert.strictEqual(log.observe('jellyfin', false), false);
  assert.strictEqual(log.observe('jellyfin', true), true);
  const h = log.history(['jellyfin']);
  assert.deepStrictEqual(h.apps.jellyfin.outages, [[10 * DAY + 60000, 10 * DAY + 15 * 60000]]);
  assert.deepStrictEqual(h.apps.jellyfin.watched, [[10 * DAY, c.t]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a restart closes open outages and shows Roost being off as a gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-uptime-'));
  const c = clock(10 * DAY);
  const first = new UptimeLog(dir, { now: c.now });
  first.observe('nova', true);
  c.t += 60000;
  first.observe('nova', false);
  c.t += 60000;
  first.save(); // last sign of life before Roost stops
  c.t += 3600000;
  const second = new UptimeLog(dir, { now: c.now });
  const restartedAt = c.t;
  c.t += 60000;
  const h = second.history(['nova']);
  // Nova's outage ends where Roost stopped watching; the hour after is no data.
  assert.deepStrictEqual(h.apps.nova.outages, [[10 * DAY + 60000, 10 * DAY + 120000]]);
  assert.strictEqual(h.apps.nova.watched.length, 2);
  // Roost's own row: the hour it was off is downtime.
  assert.deepStrictEqual(h.apps.roost.outages, [[10 * DAY + 120000, restartedAt]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history is trimmed to the window and old entries are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-uptime-'));
  const c = clock(10 * DAY);
  const log = new UptimeLog(dir, { now: c.now });
  log.observe('glint', false);
  c.t += 3600000;
  log.observe('glint', true);
  c.t += 40 * DAY;
  assert.deepStrictEqual(log.history(['glint']).apps.glint.outages, []);
  c.t += 60 * DAY;
  log.prune(c.t);
  assert.deepStrictEqual(log.apps.glint.outages, []);
  log.forget([]);
  assert.deepStrictEqual(log.apps, {});
  fs.rmSync(dir, { recursive: true, force: true });
});
