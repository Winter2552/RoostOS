'use strict';

// History behind the Power and heat charts. Every five minutes the alerts
// watcher hands over what the sensors read; this keeps a small, bounded record:
//
//   fine    one point per 5 minutes for the last 48 hours (Day chart)
//   hourly  one averaged point per hour, with peaks, for 90 days (Week, Month)
//
// It lives in memory and is written once an hour (when an hour closes) and
// when Roost stops, so a quiet day doesn't write to the SSD all day. A reading
// the machine can't give is null, and the chart leaves a gap.

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FINE_EVERY = 5 * MIN;
const FINE_KEEP = 48 * HOUR;
const HOURLY_KEEP = 90 * DAY;

const DRIVE_KEEP_DAYS = 730;

const RANGES = {
  day: { span: DAY, fine: true },
  week: { span: 7 * DAY, fine: false },
  month: { span: 30 * DAY, fine: false },
};

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

function peak(list, key) {
  const values = list.map((p) => p[key]).filter((v) => typeof v === 'number');
  return values.length ? Math.max(...values) : null;
}

class HealthHistory {
  constructor(dataDir, { now = Date.now } = {}) {
    this.file = dataDir ? path.join(dataDir, 'health-history.json') : null;
    this.now = now;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run, or an unreadable file: start fresh.
    }
    this.fine = Array.isArray(data.fine) ? data.fine : []; // { t, w, c, d }
    this.hourly = Array.isArray(data.hourly) ? data.hourly : []; // { t, w, c, d, wx, cx, dx }
    this.bucket = data.bucket || null; // the hour in progress, as running sums
    // One snapshot per drive per day, for the trend rules: key (serial or device) →
    // { name, kind, last: readAt, days: [{ d, tx, hours, wear, re, pe, un, wr }] }
    this.drives = data.drives && typeof data.drives === 'object' ? data.drives : {};
    this.dirty = false;
    this.savedAt = this.now();
  }

  // One reading: { watts, cpuTemp, driveTemp }, each a number or null. Called
  // every minute; only every 5th is kept.
  sample(reading, t = this.now()) {
    if (!reading) return;
    const { watts = null, cpuTemp = null, driveTemp = null, driveHeat = null } = reading;
    if (watts === null && cpuTemp === null && driveTemp === null) return;
    const last = this.fine[this.fine.length - 1];
    if (last && t - last.t < FINE_EVERY - 10 * 1000) return;

    this.fine.push({ t, w: round1(watts), c: cpuTemp, d: driveTemp, h: driveHeat });
    const cutoff = t - FINE_KEEP;
    while (this.fine.length && this.fine[0].t < cutoff) this.fine.shift();

    const hour = Math.floor(t / HOUR) * HOUR;
    if (this.bucket && this.bucket.t !== hour) this.closeBucket();
    if (!this.bucket) this.bucket = { t: hour, w: [0, 0, 0], c: [0, 0, 0], d: [0, 0, 0] };
    for (const [key, v] of [['w', watts], ['c', cpuTemp], ['d', driveTemp]]) {
      if (v === null) continue;
      const b = this.bucket[key]; // [sum, count, max]
      b[0] += v;
      b[1] += 1;
      b[2] = b[1] === 1 ? v : Math.max(b[2], v);
    }
    this.dirty = true;
  }

  // Today's snapshot for each drive that has a fresh reading. Called every
  // minute, but only changes (and writes) when the helper has read a drive again.
  recordDrives(drives, t = this.now()) {
    const day = new Date(t).toISOString().slice(0, 10);
    for (const d of drives || []) {
      if (!d.details || !d.readAt || d.verdict === 'unknown') continue;
      const key = d.serial || d.device;
      const entry = this.drives[key] || (this.drives[key] = { name: '', kind: '', last: null, days: [] });
      if (entry.last === d.readAt) continue;
      entry.last = d.readAt;
      entry.name = d.model || `/dev/${d.device}`;
      entry.kind = d.kind || '';
      const x = d.details;
      let today = entry.days[entry.days.length - 1];
      if (!today || today.d !== day) {
        today = { d: day };
        entry.days.push(today);
        if (entry.days.length > DRIVE_KEEP_DAYS) entry.days.shift();
      }
      today.tx = typeof x.temp === 'number' ? Math.max(today.tx ?? x.temp, x.temp) : today.tx ?? null;
      today.hours = x.hours ?? null;
      today.wear = x.wear ?? null;
      today.re = x.reallocated ?? null;
      today.pe = x.pending ?? null;
      today.un = x.uncorrectable ?? null;
      today.wr = x.written ?? null;
      this.dirty = true;
    }
    // A drive-only change still reaches the disk within the hour.
    if (this.dirty && t - this.savedAt >= HOUR) this.save();
  }

  // The hour has ended: keep its averages and peaks, and write the file.
  closeBucket() {
    const b = this.bucket;
    this.bucket = null;
    if (!b) return;
    const avg = (k) => (b[k][1] ? b[k][0] / b[k][1] : null);
    const max = (k) => (b[k][1] ? b[k][2] : null);
    this.hourly.push({ t: b.t, w: round1(avg('w')), c: avg('c') === null ? null : Math.round(avg('c')), d: avg('d') === null ? null : Math.round(avg('d')), wx: round1(max('w')), cx: max('c'), dx: max('d') });
    const cutoff = b.t - HOURLY_KEEP;
    while (this.hourly.length && this.hourly[0].t < cutoff) this.hourly.shift();
    this.save();
  }

  // For the chart: points over the range, peaks and the energy used.
  series(range, t = this.now()) {
    const r = RANGES[range] || RANGES.day;
    const from = t - r.span;
    const points = r.fine
      ? this.fine.filter((p) => p.t >= from).map((p) => ({ t: p.t, w: p.w, c: p.c, d: p.d }))
      : this.hourly.filter((p) => p.t >= from).map((p) => ({ t: p.t, w: p.w, c: p.c, d: p.d }));
    const peaks = r.fine
      ? { w: peak(this.fine.filter((p) => p.t >= from), 'w'), c: peak(this.fine.filter((p) => p.t >= from), 'c'), d: peak(this.fine.filter((p) => p.t >= from), 'd') }
      : (() => {
        const list = this.hourly.filter((p) => p.t >= from);
        return { w: peak(list, 'wx'), c: peak(list, 'cx'), d: peak(list, 'dx') };
      })();
    // Watts × the time each point stands for. Gaps (Roost off) count as nothing.
    const step = r.fine ? FINE_EVERY : HOUR;
    const watts = points.map((p) => p.w).filter((w) => typeof w === 'number');
    const kwh = (watts.reduce((a, b) => a + b, 0) * (step / HOUR)) / 1000;
    return {
      range: r === RANGES[range] ? range : 'day',
      step,
      since: points.length ? points[0].t : null,
      points,
      peaks,
      kwh: Math.round(kwh * 100) / 100,
    };
  }

  // Written when an hour closes and when Roost stops.
  save() {
    if (!this.file) return;
    const body = JSON.stringify({ version: 1, fine: this.fine, hourly: this.hourly, bucket: this.bucket, drives: this.drives });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.savedAt = this.now();
    } catch (err) {
      console.error('Saving health history failed:', err.message);
    }
  }

  flush() {
    if (this.dirty) this.save();
  }
}

module.exports = { HealthHistory, FINE_EVERY, HOURLY_KEEP, FINE_KEEP };
