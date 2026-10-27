'use strict';

// Glint memories: "On this day", trips, years and recent highlights.
//
// Nothing here looks inside a photo. Memories are worked out from the dates Glint already keeps, when
// Glint is opened, and the result is kept in memory until the day changes or the library does. There is
// no background job. Hiding a memory is remembered in the Glint SQLite file.

const DAY = 864e5;
const MIN_OTD = 4; // photos on this day in an earlier year
const TRIP_GAP_DAYS = 1; // photo days at most this far apart belong to one trip
const TRIP_MIN_PHOTOS = 30;
const YEAR_MIN_PHOTOS = 60;
const RECENT_DAYS = 14;
const RECENT_MIN = 10;
const BURST_MS = 2000; // photos this close together count as one
const PICKS = 24;
const MAX_CARDS = 12;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_hidden (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (owner, id)
  );
  CREATE TABLE IF NOT EXISTS glint_prefs (
    owner TEXT PRIMARY KEY,
    memories INTEGER NOT NULL DEFAULT 1 -- the Profile switch: 0 hides memories everywhere
  );
`;

// Favourites first, then an even spread through the time range, bursts collapsed to one frame.
function pick(rows, cap = PICKS) {
  const sorted = rows.filter((r) => !r.duration).sort((a, b) => a.taken - b.taken || (a.id < b.id ? -1 : 1));
  const spaced = [];
  for (const r of sorted) {
    const last = spaced[spaced.length - 1];
    if (last && r.taken - last.taken < BURST_MS) {
      if (r.fav && !last.fav) spaced[spaced.length - 1] = r;
      continue;
    }
    spaced.push(r);
  }
  if (spaced.length <= cap) return spaced;
  const favs = spaced.filter((r) => r.fav).slice(0, Math.floor(cap / 2));
  const chosen = new Set(favs);
  const rest = spaced.filter((r) => !chosen.has(r));
  const need = cap - favs.length;
  for (let i = 0; i < need; i++) chosen.add(rest[Math.floor(((i + 0.5) * rest.length) / need)]);
  return spaced.filter((r) => chosen.has(r));
}

const dayKey = (ms) => Math.floor(ms / DAY); // days since 1970 in the viewer's own time (ms is already shifted)
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

class Memories {
  constructor({ db, count }) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.count = count; // (owner) -> number of photos in the library
    this.cache = new Map(); // owner|tz -> { day, count, cards }
    this.q = {
      rows: db.prepare(`SELECT p.id, p.taken, p.fav, p.duration FROM photos p JOIN nodes n ON n.id = p.id
        WHERE p.owner = ? AND n.trash_root IS NULL AND p.hide = 0 AND p.thumb = 1 ORDER BY p.taken`),
      hidden: db.prepare('SELECT id FROM memory_hidden WHERE owner = ?'),
      hide: db.prepare('INSERT OR IGNORE INTO memory_hidden (owner, id) VALUES (?, ?)'),
      pref: db.prepare('SELECT memories FROM glint_prefs WHERE owner = ?'),
      setPref: db.prepare('INSERT INTO glint_prefs (owner, memories) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET memories = excluded.memories'),
    };
  }

  // Every memory for a person today, newest-feeling first. `tz` is the viewer's offset from UTC in minutes
  // (what Date#getTimezoneOffset gives, so UTC+1 is -60); photo dates are stored in UTC milliseconds.
  cards(owner, tz = 0, now = Date.now(), cap = MAX_CARDS) {
    if (!this.enabled(owner)) return [];
    const local = now - tz * 6e4;
    const today = dayKey(local);
    const total = this.count(owner);
    const key = `${owner}|${tz}`;
    const hit = this.cache.get(key);
    let cards;
    if (hit && hit.day === today && hit.count === total) cards = hit.cards;
    else {
      cards = this.make(owner, tz, local);
      this.cache.set(key, { day: today, count: total, cards });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    const hidden = new Set(this.q.hidden.all(owner).map((r) => r.id));
    return cards.filter((c) => !hidden.has(c.id)).slice(0, cap);
  }

  // The Profile switch; on until someone turns it off.
  enabled(owner) {
    const r = this.q.pref.get(owner);
    return !r || r.memories === 1;
  }

  setEnabled(owner, on) {
    this.q.setPref.run(owner, on ? 1 : 0);
  }

  hide(owner, id) {
    this.q.hide.run(owner, id);
  }

  make(owner, tz, local) {
    const rows = this.q.rows.all(owner).map((r) => ({ ...r, local: r.taken - tz * 6e4 }));
    if (!rows.length) return [];
    const todayDay = dayKey(local);
    const t = new Date(local);
    const year = t.getUTCFullYear();
    const card = (id, kind, title, sub, group) => {
      const picks = pick(group);
      return picks.length >= 3 ? { id, kind, title, sub, cover: picks[Math.floor(picks.length / 2)].id, ids: picks.map((p) => p.id), count: picks.length } : null;
    };
    const out = [];

    // On this day: the same month and day in earlier years.
    const years = new Map();
    for (const r of rows) {
      const d = new Date(r.local);
      if (d.getUTCMonth() === t.getUTCMonth() && d.getUTCDate() === t.getUTCDate() && d.getUTCFullYear() < year) {
        const y = d.getUTCFullYear();
        if (!years.has(y)) years.set(y, []);
        years.get(y).push(r);
      }
    }
    for (const y of [...years.keys()].sort((a, b) => b - a)) {
      if (years.get(y).length < MIN_OTD) continue;
      const ago = year - y;
      out.push(card(`otd-${y}-${ymd(local).slice(5)}`, 'otd', 'On this day', ago === 1 ? 'A year ago' : `${ago} years ago`, years.get(y)));
    }

    // Recent highlights.
    const recent = rows.filter((r) => dayKey(r.local) > todayDay - RECENT_DAYS);
    if (recent.length >= RECENT_MIN) out.push(card(`recent-${ymd(local)}`, 'recent', 'Recent highlights', 'The last two weeks', recent));

    // Trips: runs of photo days that are at most a day apart, with plenty of photos over two or more days.
    const runs = [];
    let run = null;
    for (const r of rows) {
      const d = dayKey(r.local);
      if (run && d - run.last <= TRIP_GAP_DAYS) { run.last = d; run.rows.push(r); }
      else { run = { first: d, last: d, rows: [r] }; runs.push(run); }
    }
    for (const r of runs.reverse()) {
      const days = r.last - r.first + 1;
      if (days < 2 || days > 21 || r.rows.length < TRIP_MIN_PHOTOS || r.last >= todayDay - 2) continue;
      const d = new Date(r.first * DAY);
      out.push(card(`trip-${ymd(r.first * DAY)}`, 'trip', `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, `${days} days · ${r.rows.length} photos`, r.rows));
    }

    // Years: the two most recent whole years.
    const byYear = new Map();
    for (const r of rows) {
      const y = new Date(r.local).getUTCFullYear();
      if (y < year) { if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r); }
    }
    for (const y of [...byYear.keys()].sort((a, b) => b - a).slice(0, 2)) {
      if (byYear.get(y).length >= YEAR_MIN_PHOTOS) out.push(card(`year-${y}`, 'year', `${y} in photos`, 'Year in review', byYear.get(y)));
    }
    return out.filter(Boolean);
  }

  // One memory with its card, or null when it no longer exists or was hidden.
  find(owner, id, tz = 0) {
    return this.cards(owner, tz, Date.now(), Infinity).find((c) => c.id === id) || null;
  }
}

module.exports = { Memories, pick };
