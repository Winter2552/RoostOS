'use strict';

// Heads-up before a drive fails. Works on the daily drive snapshots and the
// 5-minute heat points in health-history.js, and returns problems for the
// alerts watcher to raise (so grace, push, clearing and the 7-day list all
// come from the alerts already built). It also gives each drive an outlook for
// the status page. Nothing here reads a drive: it only looks at the record.

const { HOT } = require('./smart');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

// Replaced sectors gained in a week that earn a warning.
const SECTORS_PER_WEEK = 3;
// An SSD "needs replacing" at this % of its rated life (same line as drive health).
const WEAR_LIMIT = 95;
// Warn when that is under a year away.
const WEAR_WARN_DAYS = 365;
// A trend needs this much history to mean anything.
const WEAR_MIN_SPAN_DAYS = 14;
const HEAT_MIN_SPAN = 28 * MIN;
const HEAT_POINTS = 7;
// While a heat alert is open, the drive must cool this far below its limit to clear it.
const HEAT_CLEAR_MARGIN = 3;
const SILENT_DAYS = 2;

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

// How far over its "running hot" limit the hottest awake drive is (negative: under).
function heatMargin(drives) {
  let worst = null;
  for (const d of drives || []) {
    const temp = d.details && d.details.temp;
    if (typeof temp !== 'number' || d.asleep) continue;
    const limit = (HOT[d.kind] || HOT.HDD)[0];
    if (worst === null || temp - limit > worst) worst = temp - limit;
  }
  return worst;
}

function hottest(drives) {
  return (drives || [])
    .filter((d) => d.details && typeof d.details.temp === 'number' && !d.asleep)
    .sort((a, b) => b.details.temp - a.details.temp)[0] || null;
}

// Replaced sectors gained over the last week of snapshots.
function sectorGrowth(days, now) {
  const week = days.filter((x) => dayMs(x.d) >= now - 7 * DAY && typeof x.re === 'number');
  if (week.length < 2) return null;
  const a = week[0];
  const b = week[week.length - 1];
  return { grew: b.re - a.re, spanDays: Math.max(1, Math.round((dayMs(b.d) - dayMs(a.d)) / DAY)) };
}

// SSD wear rate over up to 90 days. null until there are two weeks to go on.
function wearOutlook(days, now) {
  const list = days.filter((x) => dayMs(x.d) >= now - 90 * DAY && typeof x.wear === 'number');
  if (list.length < 2) return null;
  const a = list[0];
  const b = list[list.length - 1];
  const span = (dayMs(b.d) - dayMs(a.d)) / DAY;
  if (span < WEAR_MIN_SPAN_DAYS) return null;
  const perDay = (b.wear - a.wear) / span;
  if (perDay <= 0) return { wear: b.wear, yearsLeft: null, daysLeft: null };
  const daysLeft = Math.max(0, WEAR_LIMIT - b.wear) / perDay;
  return { wear: b.wear, daysLeft, yearsLeft: Math.round((daysLeft / 365) * 10) / 10 };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// { device → { sectorsWeek, yearsLeft, wear } } for the drives the status page lists.
function outlooks(history, drives, now) {
  const out = {};
  for (const d of drives || []) {
    const entry = history.drives[d.serial || d.device];
    if (!entry) continue;
    const g = sectorGrowth(entry.days, now);
    const w = entry.kind === 'SSD' ? wearOutlook(entry.days, now) : null;
    out[d.device] = {
      sectorsWeek: g ? g.grew : null,
      yearsLeft: w ? w.yearsLeft : null,
      wearTracked: !!w,
    };
  }
  return out;
}

// What is worth a heads-up right now, as key → { title, detail, ok }.
// `open` is the set of keys that already have an alert (for the heat margin).
function trendProblems({ history, driveHealth, now, open = new Set() }) {
  const found = new Map();
  const drives = driveHealth && !driveHealth.missing ? driveHealth.drives : [];
  const fresh = driveHealth && !driveHealth.missing && !driveHealth.stale;
  const byKey = new Map(drives.map((d) => [d.serial || d.device, d]));

  for (const [key, entry] of Object.entries(history.drives)) {
    const name = entry.name || key;
    const g = sectorGrowth(entry.days, now);
    if (g && g.grew >= SECTORS_PER_WEEK) {
      found.set(`trend-sectors:${key}`, {
        title: `${name} is losing sectors`,
        detail: `${plural(g.grew, 'more worn-out sector', 'more worn-out sectors')} in ${plural(g.spanDays, 'day', 'days')}. Back up anything you can't lose.`,
        ok: `${name} has stopped losing sectors`,
      });
    }
    if (entry.kind === 'SSD') {
      const w = wearOutlook(entry.days, now);
      if (w && w.daysLeft !== null && w.daysLeft < WEAR_WARN_DAYS) {
        const months = Math.max(1, Math.round(w.daysLeft / 30));
        found.set(`trend-wear:${key}`, {
          title: `${name} is wearing out`,
          detail: `${w.wear}% used. At this rate it reaches ${WEAR_LIMIT}% in about ${plural(months, 'month', 'months')}. Plan a replacement.`,
          ok: `${name} is wearing slower`,
        });
      }
    }
    // Not read for days while the helper is running and the drive isn't asleep.
    const live = byKey.get(key);
    const last = entry.days[entry.days.length - 1];
    if (fresh && last && !(live && live.asleep) && now - dayMs(last.d) > SILENT_DAYS * DAY) {
      const days = Math.floor((now - dayMs(last.d)) / DAY);
      found.set(`trend-silent:${key}`, {
        title: `${name} stopped reporting`,
        detail: `No health reading for ${plural(days, 'day', 'days')}. Is it plugged in?`,
        ok: `${name} is reporting again`,
      });
    }
  }

  for (const d of drives) {
    const x = d.details;
    if (!x || d.verdict === 'unknown') continue;
    const bad = (x.pending || 0) + (x.uncorrectable || 0);
    if (bad > 0) {
      found.set(`trend-unreadable:${d.serial || d.device}`, {
        title: `${d.model || `/dev/${d.device}`} has unreadable sectors`,
        detail: `${plural(bad, 'sector', 'sectors')} can't be read. Back up now.`,
        ok: `${d.model || `/dev/${d.device}`} reads cleanly again`,
      });
    }
  }

  // Heat for half an hour, not a spike. Once open it clears a few degrees lower.
  const recent = history.fine.slice(-HEAT_POINTS);
  const hotNow = hottest(drives);
  if (hotNow && recent.length >= HEAT_POINTS) {
    const sustained = recent.every((p) => typeof p.h === 'number' && p.h >= 0)
      && recent[recent.length - 1].t - recent[0].t >= HEAT_MIN_SPAN
      && recent[recent.length - 1].t - recent[0].t <= 45 * MIN;
    const stays = open.has('trend-heat') && typeof recent[recent.length - 1].h === 'number' && recent[recent.length - 1].h >= -HEAT_CLEAR_MARGIN;
    if (sustained || stays) {
      found.set('trend-heat', {
        title: 'A drive is running hot',
        detail: `${hotNow.model || `/dev/${hotNow.device}`} · ${hotNow.details.temp}°C for over half an hour. Check the airflow.`,
        ok: 'The drive has cooled down',
      });
    }
  }
  return found;
}

module.exports = { trendProblems, outlooks, heatMargin, hottest, sectorGrowth, wearOutlook, SECTORS_PER_WEEK, WEAR_LIMIT };
