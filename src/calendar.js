'use strict';

// Read-only calendars for Cockerel. Raven pastes the secret "iCal" link from
// Google, Apple or Outlook; Roost fetches it (never the VM, so the link stays
// here), reads the events and answers "what's on this week?". There is no
// sign-in with Google and nothing is ever written back.

const { parseAt, validZone } = require('./assistant');

const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 15 * 60 * 1000;
const DAY = 86400e3;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// "webcal://x" is just https. Only https links to a real host are taken.
function cleanUrl(raw) {
  const u = String(raw || '').trim().replace(/^webcal:\/\//i, 'https://');
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  return url.href;
}

function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeText(s) {
  return String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

// "20261105T090000Z", "20261105T090000" with a zone, or "20261105" all day.
function parseDate(value, params, fallbackTz) {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', , z] = m;
  if (!m[4]) return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true, y: +y, mo: +mo, d: +d, tz: 'UTC' };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi), allDay: false, y: +y, mo: +mo, d: +d, h: +h, mi: +mi, tz: 'UTC' };
  const tz = validZone(params.TZID) ? params.TZID : fallbackTz;
  const ms = parseAt(`${y}-${mo}-${d} ${h}:${mi}`, tz);
  return ms === null ? null : { ms, allDay: false, y: +y, mo: +mo, d: +d, h: +h, mi: +mi, tz };
}

function parseIcs(text, fallbackTz = 'Europe/London') {
  const events = [];
  let ev = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (ev && ev.start && ev.summary !== undefined && !ev.cancelled) {
        if (!ev.end) ev.end = { ms: ev.start.ms + (ev.start.allDay ? DAY : 0) };
        events.push(ev);
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rest] = line.slice(0, i).split(';');
    const params = Object.fromEntries(rest.map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.toUpperCase(), v.replace(/"/g, '')]));
    const value = line.slice(i + 1);
    switch (name.toUpperCase()) {
      case 'SUMMARY': ev.summary = unescapeText(value).slice(0, 120); break;
      case 'LOCATION': ev.location = unescapeText(value).slice(0, 80); break;
      case 'STATUS': ev.cancelled = /CANCELLED/i.test(value); break;
      case 'DTSTART': ev.start = parseDate(value, params, fallbackTz); break;
      case 'DTEND': ev.end = parseDate(value, params, fallbackTz); break;
      case 'EXDATE': for (const v of value.split(',')) { const d = parseDate(v, params, fallbackTz); if (d) ev.exdates.push(d.allDay ? `${d.y}-${d.mo}-${d.d}` : d.ms); } break;
      case 'RRULE': ev.rrule = Object.fromEntries(value.split(';').map((p) => p.split('=')).filter((p) => p.length === 2)); break;
      default:
    }
  }
  return events;
}

const pad = (n) => String(n).padStart(2, '0');
const wallToMs = (ev, y, mo, d) => (ev.start.allDay ? Date.UTC(y, mo - 1, d)
  : ev.start.tz === 'UTC' ? Date.UTC(y, mo - 1, d, ev.start.h, ev.start.mi)
    : parseAt(`${y}-${pad(mo)}-${pad(d)} ${pad(ev.start.h)}:${pad(ev.start.mi)}`, ev.start.tz));

// The nth (1-4, or -1 for last) weekday of a month, as a day of month.
function nthWeekday(y, mo, dow, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  }
  const last = new Date(Date.UTC(y, mo, 0));
  return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7);
}

// Every time this event happens between from and to (milliseconds).
function occurrences(ev, from, to) {
  const length = ev.end.ms - ev.start.ms;
  const hit = (ms) => ms + length > from && ms < to;
  const skipped = (ms, y, mo, d) => ev.exdates.includes(ev.start.allDay ? `${y}-${mo}-${d}` : ms);
  const out = [];
  if (!ev.rrule || !ev.rrule.FREQ) {
    if (hit(ev.start.ms)) out.push({ start: ev.start.ms, end: ev.start.ms + length });
    return out;
  }
  const r = ev.rrule;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = Number(r.COUNT) || Infinity;
  const untilDate = r.UNTIL ? parseDate(r.UNTIL, {}, 'UTC') : null;
  const until = untilDate ? untilDate.ms + (untilDate.allDay ? DAY : 0) : Infinity;
  const days = String(r.BYDAY || '').split(',').filter(Boolean).map((t) => ({ n: Number(/^[+-]?\d+/.exec(t) && /^[+-]?\d+/.exec(t)[0]) || 0, dow: WEEKDAYS.indexOf(t.replace(/^[+-]?\d+/, '')) })).filter((t) => t.dow >= 0);
  const startDay = Date.UTC(ev.start.y, ev.start.mo - 1, ev.start.d);
  const startDow = new Date(startDay).getUTCDay();
  const lastDay = Math.min(to, until) + DAY;
  let n = 0;
  for (let day = startDay, guard = 0; day <= lastDay && n < count && guard < 20000; day += DAY, guard++) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const dow = dt.getUTCDay();
    const diff = Math.round((day - startDay) / DAY);
    let on = false;
    if (r.FREQ === 'DAILY') on = diff % interval === 0;
    else if (r.FREQ === 'WEEKLY') on = Math.floor((diff + startDow) / 7) % interval === 0 && (days.length ? days.some((t) => t.dow === dow) : dow === startDow);
    else if (r.FREQ === 'MONTHLY') {
      const months = (y - ev.start.y) * 12 + (mo - ev.start.mo);
      on = months >= 0 && months % interval === 0 && (days.length ? days.some((t) => t.n && nthWeekday(y, mo, t.dow, t.n) === d) : d === (Number(r.BYMONTHDAY) || ev.start.d));
    } else if (r.FREQ === 'YEARLY') on = (y - ev.start.y) % interval === 0 && mo === ev.start.mo && d === ev.start.d;
    if (!on) continue;
    const ms = wallToMs(ev, y, mo, d);
    if (ms === null || ms > until) continue;
    n += 1;
    if (skipped(ms, y, mo, d)) continue;
    if (hit(ms)) out.push({ start: ms, end: ms + length });
  }
  return out;
}

const fmt = (tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });

// Plain lines for Claude and the brief: "Mon 2 Nov 09:00-10:00 Dentist (High St)".
function lines(items, tz) {
  const day = fmt(tz, { weekday: 'short', day: 'numeric', month: 'short' });
  const allDay = fmt('UTC', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return items.map((o) => `${(o.allDay ? allDay : day).format(o.start)} ${o.allDay ? 'all day' : `${time.format(o.start)}-${time.format(o.end)}`} ${o.summary}${o.location ? ` (${o.location})` : ''}`);
}

class Calendars {
  constructor({ assistant, seal, open, fetchImpl = fetch, now = Date.now }) {
    this.assistant = assistant;
    this.seal = seal;
    this.open = open;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
  }

  list() {
    const a = this.assistant.data();
    if (!Array.isArray(a.calendars)) a.calendars = [];
    return a.calendars;
  }

  view() {
    return this.list().map((c) => ({ id: c.id, name: c.name }));
  }

  async load(url) {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.events;
    let res;
    try { res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' }); } catch { throw new Error("Couldn't reach that calendar link"); }
    if (!res.ok) throw new Error(`The calendar link answered ${res.status}. Is it still switched on?`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('That calendar is too big');
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link isn't an iCal calendar");
    const events = parseIcs(text, this.assistant.tz());
    this.cache.set(url, { at: this.now(), events });
    return events;
  }

  async add(name, link, newId) {
    const url = cleanUrl(link);
    if (!url) throw new Error('Paste the secret iCal link (https or webcal)');
    const clean = String(name || '').trim().slice(0, 40) || 'Calendar';
    if (this.list().length >= 5) throw new Error('Five calendars is the most');
    const events = await this.load(url); // proves the link works before it is saved
    this.list().push({ id: newId(), name: clean, url: this.seal(url) });
    this.assistant.store.save();
    return events.length;
  }

  remove(id) {
    const a = this.list();
    const i = a.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.cache.delete(this.open(a[i].url));
    a.splice(i, 1);
    this.assistant.store.save();
    return true;
  }

  // Events in the next `days` days (default today only, 0), soonest first.
  async upcoming(days = 7) {
    const tz = this.assistant.tz();
    const from = this.now();
    const startOfToday = parseAt(`${new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(from)} 00:00`, tz);
    const to = startOfToday + (Math.min(Math.max(Math.floor(days), 0), 60) + 1) * DAY;
    const items = [];
    const problems = [];
    for (const c of this.list()) {
      try {
        for (const ev of await this.load(this.open(c.url))) {
          for (const o of occurrences(ev, startOfToday, to)) items.push({ ...o, summary: ev.summary, location: ev.location, allDay: ev.start.allDay, calendar: c.name });
        }
      } catch (err) { problems.push(`${c.name}: ${err.message}`); }
    }
    items.sort((x, y) => x.start - y.start);
    return { lines: lines(items.slice(0, 60), tz), problems };
  }
}

module.exports = { Calendars, parseIcs, occurrences, cleanUrl, lines };
