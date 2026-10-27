'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HealthHistory, FINE_EVERY } = require('../src/health-history');
const { trendProblems, outlooks, heatMargin, sectorGrowth, wearOutlook } = require('../src/drive-trends');
const { Watcher, findProblems, alertSettings, DEFAULTS } = require('../src/alerts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-trends-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const dayOf = (offset) => new Date(NOW - offset * DAY).toISOString().slice(0, 10);

function drive(over = {}) {
  return {
    device: 'sdb', serial: 'WD123', model: 'WDC 3TB', kind: 'HDD', verdict: 'good', asleep: false,
    readAt: new Date(NOW).toISOString(),
    details: { temp: 38, hours: 3000, wear: null, written: null, reallocated: 0, pending: 0, uncorrectable: 0 },
    ...over,
  };
}
const health = (drives, over = {}) => ({ drives, checkedAt: new Date(NOW).toISOString(), stale: false, ...over });

function historyWith(key, kind, days, name = 'WDC 3TB') {
  const h = new HealthHistory(null);
  h.drives[key] = { name, kind, last: null, days };
  return h;
}

test('one snapshot a day per drive, updated only when the helper reads the drive again', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rec-'));
  // The history's own clock is pinned to the test's, or "within the hour" depends on today's date.
  const h = new HealthHistory(dir, { now: () => NOW });
  h.recordDrives([drive({ details: { temp: 38, hours: 100, reallocated: 0, pending: 0, uncorrectable: 0, wear: null } })], NOW);
  h.recordDrives([drive({ details: { temp: 38, hours: 999 } })], NOW + MIN); // same readAt: ignored
  assert.equal(h.drives.WD123.days.length, 1);
  assert.equal(h.drives.WD123.days[0].hours, 100);

  // A later reading the same day keeps the day's hottest temperature.
  h.recordDrives([drive({ readAt: new Date(NOW + HOURS(1)).toISOString(), details: { temp: 44, hours: 101, reallocated: 2 } })], NOW + HOURS(1));
  h.recordDrives([drive({ readAt: new Date(NOW + HOURS(2)).toISOString(), details: { temp: 36, hours: 102, reallocated: 2 } })], NOW + HOURS(2));
  assert.equal(h.drives.WD123.days.length, 1);
  assert.equal(h.drives.WD123.days[0].tx, 44);
  assert.equal(h.drives.WD123.days[0].re, 2);

  // Next day starts a new snapshot; an unreadable drive records nothing.
  h.recordDrives([drive({ readAt: new Date(NOW + DAY).toISOString() })], NOW + DAY);
  h.recordDrives([{ device: 'sdc', verdict: 'unknown' }], NOW + DAY);
  assert.equal(h.drives.WD123.days.length, 2);
  assert.equal(Object.keys(h.drives).length, 1);

  // It reaches the file within the hour of a change, and survives a restart.
  h.recordDrives([drive({ readAt: new Date(NOW + DAY + HOURS(2)).toISOString() })], NOW + DAY + HOURS(2));
  assert.equal(new HealthHistory(dir).drives.WD123.days.length, 2);
});

function HOURS(n) { return n * 60 * MIN; }

test('three or more new worn-out sectors in a week raise a heads-up, and it clears when it settles', () => {
  const days = [{ d: dayOf(6), re: 0 }, { d: dayOf(3), re: 1 }, { d: dayOf(0), re: 4 }];
  const h = historyWith('WD123', 'HDD', days);
  assert.deepEqual(sectorGrowth(days, NOW), { grew: 4, spanDays: 6 });
  const found = trendProblems({ history: h, driveHealth: health([drive()]), now: NOW });
  const p = found.get('trend-sectors:WD123');
  assert.equal(p.title, 'WDC 3TB is losing sectors');
  assert.match(p.detail, /4 more worn-out sectors in 6 days\. Back up/);

  // Two sectors is not enough. A single snapshot proves nothing.
  assert.equal(trendProblems({ history: historyWith('WD123', 'HDD', [{ d: dayOf(5), re: 0 }, { d: dayOf(0), re: 2 }]), driveHealth: health([drive()]), now: NOW }).size, 0);
  assert.equal(sectorGrowth([{ d: dayOf(0), re: 9 }], NOW), null);
  // Old growth outside the week doesn't count.
  assert.equal(trendProblems({ history: historyWith('WD123', 'HDD', [{ d: dayOf(40), re: 0 }, { d: dayOf(20), re: 30 }, { d: dayOf(2), re: 30 }, { d: dayOf(0), re: 30 }]), driveHealth: health([drive()]), now: NOW }).size, 0);
});

test('unreadable sectors are an alert straight away', () => {
  const h = new HealthHistory(null);
  const found = trendProblems({ history: h, driveHealth: health([drive({ details: { temp: 38, pending: 2, uncorrectable: 1 } })]), now: NOW });
  assert.match(found.get('trend-unreadable:WD123').detail, /3 sectors can't be read\. Back up now/);
});

test('SSD wear is projected from the last 90 days, once there are two weeks of history', () => {
  const slow = [{ d: dayOf(60), wear: 10 }, { d: dayOf(0), wear: 11 }]; // 1% in 60 days
  const w = wearOutlook(slow, NOW);
  assert.equal(w.wear, 11);
  assert.ok(w.yearsLeft > 13 && w.yearsLeft < 14.5, `got ${w.yearsLeft}`);
  assert.equal(trendProblems({ history: historyWith('SSD1', 'SSD', slow), driveHealth: health([]), now: NOW }).size, 0);

  const fast = [{ d: dayOf(30), wear: 70 }, { d: dayOf(0), wear: 80 }]; // 1% per 3 days, 15% to go
  const found = trendProblems({ history: historyWith('SSD1', 'SSD', fast, 'Kingston'), driveHealth: health([]), now: NOW });
  assert.equal(found.get('trend-wear:SSD1').title, 'Kingston is wearing out');
  assert.match(found.get('trend-wear:SSD1').detail, /80% used\. At this rate it reaches 95% in about 2 months/);

  assert.equal(wearOutlook([{ d: dayOf(5), wear: 10 }, { d: dayOf(0), wear: 12 }], NOW), null); // too little history
  assert.deepEqual(wearOutlook([{ d: dayOf(30), wear: 11 }, { d: dayOf(0), wear: 11 }], NOW), { wear: 11, yearsLeft: null, daysLeft: null });
  // Hard drives have no wear to forecast.
  assert.equal(trendProblems({ history: historyWith('WD123', 'HDD', fast), driveHealth: health([]), now: NOW }).size, 0);
});

test('outlooks give each listed drive its years left and sector change', () => {
  const h = historyWith('SSD1', 'SSD', [{ d: dayOf(60), wear: 10, re: 0 }, { d: dayOf(0), wear: 11, re: 0 }]);
  const out = outlooks(h, [drive({ device: 'sda', serial: 'SSD1', kind: 'SSD' }), drive({ device: 'sdz', serial: 'nothing-yet' })], NOW);
  assert.equal(out.sda.wearTracked, true);
  assert.ok(out.sda.yearsLeft > 13);
  assert.equal(out.sda.sectorsWeek, null); // one snapshot in the week: nothing to compare
  assert.equal(out.sdz, undefined);
});

function heatPoints(h, margins, start = NOW - 40 * MIN) {
  margins.forEach((m, i) => h.fine.push({ t: start + i * FINE_EVERY, w: 10, c: 45, d: 52, h: m }));
}

test('heat has to last half an hour, and clears a little lower', () => {
  const warm = drive({ details: { temp: 53 } });
  // Seven points over the limit across 30 minutes.
  const h = new HealthHistory(null);
  heatPoints(h, [1, 2, 3, 3, 2, 3, 3]);
  const found = trendProblems({ history: h, driveHealth: health([warm]), now: NOW });
  assert.equal(found.get('trend-heat').title, 'A drive is running hot');
  assert.match(found.get('trend-heat').detail, /WDC 3TB · 53°C for over half an hour\. Check the airflow/);

  // A short spike is quiet.
  const spike = new HealthHistory(null);
  heatPoints(spike, [-5, -5, -5, -5, 4, 4, 4]);
  assert.equal(trendProblems({ history: spike, driveHealth: health([warm]), now: NOW }).size, 0);

  // Cooled just under the limit: an open alert stays until 3° below.
  const cooling = new HealthHistory(null);
  heatPoints(cooling, [3, 3, 3, 1, 0, -1, -2]);
  assert.equal(trendProblems({ history: cooling, driveHealth: health([warm]), now: NOW }).size, 0);
  assert.equal(trendProblems({ history: cooling, driveHealth: health([warm]), now: NOW, open: new Set(['trend-heat']) }).size, 1);
  const cool = new HealthHistory(null);
  heatPoints(cool, [3, 3, 3, 1, 0, -2, -4]);
  assert.equal(trendProblems({ history: cool, driveHealth: health([warm]), now: NOW, open: new Set(['trend-heat']) }).size, 0);

  // A gap in the record (Roost was off) is not 30 minutes of heat.
  const gappy = new HealthHistory(null);
  heatPoints(gappy, [3, 3, 3, 3, 3, 3, 3], NOW - 3 * 60 * MIN);
  gappy.fine[3].t += 80 * MIN;
  gappy.fine.sort((a, b) => a.t - b.t);
  assert.equal(trendProblems({ history: gappy, driveHealth: health([warm]), now: NOW }).size, 0);
});

test('heatMargin counts only drives that are awake, against their own kind of limit', () => {
  assert.equal(heatMargin([drive({ details: { temp: 53 } })]), 3); // HDD limit 50
  assert.equal(heatMargin([drive({ kind: 'SSD', details: { temp: 53 } })]), -17); // SSD limit 70
  assert.equal(heatMargin([drive({ asleep: true, details: { temp: 70 } })]), null);
  assert.equal(heatMargin([]), null);
});

test('a drive that stops reporting is flagged, unless it is just asleep or the helper is down', () => {
  const h = historyWith('WD123', 'HDD', [{ d: dayOf(4), re: 0 }]);
  const silent = trendProblems({ history: h, driveHealth: health([]), now: NOW });
  assert.match(silent.get('trend-silent:WD123').detail, /No health reading for 4 days\. Is it plugged in\?/);
  assert.equal(trendProblems({ history: h, driveHealth: health([drive({ asleep: true })]), now: NOW }).size, 0);
  assert.equal(trendProblems({ history: h, driveHealth: health([], { stale: true }), now: NOW }).size, 0);
  assert.equal(trendProblems({ history: h, driveHealth: { missing: true, drives: [] }, now: NOW }).size, 0);
  assert.equal(trendProblems({ history: historyWith('WD123', 'HDD', [{ d: dayOf(1), re: 0 }]), driveHealth: health([]), now: NOW }).size, 0);
});

test('findProblems only includes trends when the setting is on, and on by default', () => {
  assert.equal(DEFAULTS.alertDriveTrend, true);
  const trends = new Map([['trend-heat', { title: 'A drive is running hot', detail: '', ok: '' }]]);
  const args = { apps: [], docker: null, disks: [], open: new Set(), trends };
  assert.equal(findProblems({ ...args, settings: alertSettings({ settings: {} }) }).size, 1);
  assert.equal(findProblems({ ...args, settings: alertSettings({ settings: { alertDriveTrend: false } }) }).size, 0);
});

test('the watcher raises a trend alert after the grace period and clears it when it passes', async () => {
  let clock = NOW;
  let problems = new Map([['trend-sectors:WD123', { title: 'WDC 3TB is losing sectors', detail: '4 more worn-out sectors in 6 days.', ok: 'WDC 3TB has stopped losing sectors' }]]);
  const store = { db: { settings: {}, apps: [], users: [] }, save() {} };
  let n = 0;
  const events = [];
  const watcher = new Watcher({
    store, newId: () => `t${n++}`, now: () => clock,
    readContainers: async () => ({ containers: [] }), readDisks: () => [],
    readTrends: () => problems,
    onChange: (kind, alert) => events.push([kind, alert.title]),
  });
  await watcher.check();
  assert.deepEqual(store.db.alerts || [], []); // not yet: it has to last 2 minutes
  clock += 3 * MIN;
  await watcher.check();
  assert.deepEqual(events, [['raised', 'WDC 3TB is losing sectors']]);
  problems = new Map();
  clock += MIN;
  await watcher.check();
  assert.equal(events[1][0], 'resolved');

  // Switched off, nothing is read at all.
  store.db.settings.alertDriveTrend = false;
  let read = 0;
  watcher.readTrends = () => { read++; return problems; };
  await watcher.check();
  assert.equal(read, 0);
});
