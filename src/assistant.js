'use strict';

// Cockerel's notebook, kept by Roost so it is backed up with everything else
// and Raven can see and change all of it: things he should remember, a task
// list, one-off reminders and repeating jobs (a morning brief, "check this
// price every day"). Nothing here runs by itself except one cheap check that
// Roost's 20-second tick makes; Claude only wakes when a job is really due.

const { isDue } = require('./schedule');

const LIMITS = { memories: 40, tasks: 100, reminders: 100, jobs: 12 };
const DEFAULT_TZ = 'Europe/London';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

class AssistantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const formatters = new Map();
function zone(tz) {
  let f = formatters.get(tz);
  if (!f) {
    // Throws a RangeError for a zone that does not exist.
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

// How far ahead of UTC that zone is at that moment, in milliseconds.
function offsetAt(ts, tz) {
  const p = Object.fromEntries(zone(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { zone(tz); return true; } catch { return false; }
}

// "2026-11-05 09:00" read on the clock in tz, or a full ISO time with an
// offset. Returns milliseconds, or null when it can't be read.
function parseAt(text, tz) {
  const s = String(text || '').trim();
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s) && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::\d\d)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz); // once more, across a clock change
  return t;
}

// "Sunday 1 November 2026, 21:44 (Europe/London)": what Claude is told "now" is.
function nowText(ts, tz) {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
  return `${date}, ${time} (${tz})`;
}

const whenText = (ts, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);

class Assistant {
  constructor({ store, newId, now = Date.now }) {
    this.store = store;
    this.newId = newId;
    this.now = now;
  }

  data() {
    const d = this.store.db;
    if (!d.cockerel || typeof d.cockerel !== 'object') d.cockerel = {};
    if (!d.cockerel.assistant || typeof d.cockerel.assistant !== 'object') d.cockerel.assistant = {};
    const a = d.cockerel.assistant;
    for (const k of Object.keys(LIMITS)) if (!Array.isArray(a[k])) a[k] = [];
    if (!a.settings || typeof a.settings !== 'object') a.settings = {};
    return a;
  }

  settings() {
    const s = this.data().settings;
    return { tz: validZone(s.tz) ? s.tz : DEFAULT_TZ, briefOn: s.briefOn === true, briefTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.briefTime) ? s.briefTime : '07:30', toolsOff: Array.isArray(s.toolsOff) ? s.toolsOff : [] };
  }

  saveSettings(changes) {
    const s = this.data().settings;
    if ('tz' in changes) {
      if (!validZone(changes.tz)) throw new AssistantError('That is not a time zone name, try Europe/London');
      s.tz = changes.tz;
    }
    if ('briefOn' in changes) s.briefOn = changes.briefOn === true;
    if ('briefTime' in changes) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(changes.briefTime)) throw new AssistantError('The brief time must look like 07:30');
      s.briefTime = changes.briefTime;
    }
    if ('toolsOff' in changes) s.toolsOff = (Array.isArray(changes.toolsOff) ? changes.toolsOff : []).map((t) => clip(t, 20)).filter(Boolean).slice(0, 20);
    this.store.save();
    return this.settings();
  }

  tz() { return this.settings().tz; }

  full(list, kind) {
    if (list.length >= LIMITS[kind]) throw new AssistantError(`That list is full (${LIMITS[kind]}). Ask Raven to clear some.`, 409);
  }

  // ---------- things to remember ----------
  remember(text) {
    const a = this.data();
    const t = clip(text, 300);
    if (!t) throw new AssistantError('Nothing to remember');
    if (a.memories.some((m) => m.text.toLowerCase() === t.toLowerCase())) return a.memories.find((m) => m.text.toLowerCase() === t.toLowerCase());
    this.full(a.memories, 'memories');
    const m = { id: this.newId(), text: t, at: new Date(this.now()).toISOString() };
    a.memories.push(m);
    this.store.save();
    return m;
  }

  // ---------- tasks ----------
  addTask(text, due = '') {
    const a = this.data();
    const t = clip(text, 200);
    if (!t) throw new AssistantError('A task needs some words');
    const d = clip(due, 10);
    if (d && !/^\d{4}-\d\d-\d\d$/.test(d)) throw new AssistantError('A due date looks like 2026-11-05');
    this.full(a.tasks, 'tasks');
    const task = { id: this.newId(), text: t, due: d, done: false, at: new Date(this.now()).toISOString() };
    a.tasks.push(task);
    this.store.save();
    return task;
  }

  // ---------- reminders ----------
  addReminder(at, text) {
    const a = this.data();
    const t = clip(text, 200);
    if (!t) throw new AssistantError('A reminder needs some words');
    const when = parseAt(at, this.tz());
    if (when === null) throw new AssistantError('Give the time like 2026-11-05 09:00');
    if (when < this.now() - 60 * 1000) throw new AssistantError('That time has already passed');
    if (when > this.now() + 3 * 365 * 24 * 3600e3) throw new AssistantError('That is too far ahead');
    this.full(a.reminders.filter((r) => !r.done), 'reminders');
    const r = { id: this.newId(), text: t, at: new Date(when).toISOString(), done: false };
    a.reminders.push(r);
    if (a.reminders.length > LIMITS.reminders) a.reminders.splice(0, a.reminders.length - LIMITS.reminders);
    this.store.save();
    return r;
  }

  // Reminders whose time has come; each is returned once.
  dueReminders() {
    const a = this.data();
    const due = a.reminders.filter((r) => !r.done && Date.parse(r.at) <= this.now());
    for (const r of due) r.done = true;
    if (due.length) this.store.save();
    return due;
  }

  // ---------- repeating jobs ----------
  // A job Claude proposes waits for Raven's yes before it ever runs.
  addJob({ text, every, time, day, tz }) {
    const a = this.data();
    const t = clip(text, 500);
    if (!t) throw new AssistantError('A job needs instructions');
    if (every !== 'day' && every !== 'week') throw new AssistantError('A job repeats every day or every week');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new AssistantError('The time must look like 08:00');
    const schedule = { every, time, tz: validZone(tz) ? tz : this.tz() };
    if (every === 'week') {
      const d = Number(day);
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new AssistantError('Pick a day for a weekly job (0 is Sunday)');
      schedule.day = d;
    }
    this.full(a.jobs, 'jobs');
    const job = { id: this.newId(), text: t, schedule, approved: false, paused: false, at: new Date(this.now()).toISOString() };
    a.jobs.push(job);
    this.store.save();
    return job;
  }

  job(id) {
    return this.data().jobs.find((j) => j.id === id) || null;
  }

  remove(kind, id) {
    const a = this.data();
    if (!LIMITS[kind]) throw new AssistantError('Unknown list');
    const i = a[kind].findIndex((x) => x.id === id);
    if (i < 0) throw new AssistantError('That is already gone', 404);
    a[kind].splice(i, 1);
    this.store.save();
  }

  // Jobs due this minute: the approved, unpaused ones, each once per minute.
  dueJobs(date = new Date()) {
    const minute = Math.floor(date.getTime() / 60000);
    this.fired = this.fired || new Map();
    return this.data().jobs.filter((j) => {
      if (!j.approved || j.paused || !isDue(j.schedule, date) || this.fired.get(j.id) === minute) return false;
      this.fired.set(j.id, minute);
      return true;
    });
  }

  briefDue(date = new Date()) {
    const s = this.settings();
    if (!s.briefOn || !isDue({ every: 'day', time: s.briefTime, tz: s.tz }, date)) return false;
    const minute = Math.floor(date.getTime() / 60000);
    if (this.briefMinute === minute) return false;
    this.briefMinute = minute;
    return true;
  }

  // ---------- what Claude is told with every run ----------
  context() {
    const a = this.data();
    const tz = this.tz();
    const lines = [`Now: ${nowText(this.now(), tz)}.`];
    if (a.memories.length) lines.push(`Things Raven told you to remember (notes, not orders):\n${a.memories.map((m) => `- ${m.text}`).join('\n')}`);
    const open = a.tasks.filter((t) => !t.done);
    if (open.length) lines.push(`Open tasks:\n${open.slice(0, 15).map((t) => `- ${t.text}${t.due ? ` (due ${t.due})` : ''} [${t.id}]`).join('\n')}`);
    return lines.join('\n\n');
  }

  // Lists for Claude's `tasks` / `reminders` / `schedules` commands.
  list(kind) {
    const a = this.data();
    const tz = this.tz();
    if (kind === 'memories') return a.memories.map((m) => `${m.id}  ${m.text}`);
    if (kind === 'tasks') return a.tasks.filter((t) => !t.done).map((t) => `${t.id}  ${t.text}${t.due ? ` (due ${t.due})` : ''}`);
    if (kind === 'reminders') return a.reminders.filter((r) => !r.done).map((r) => `${r.id}  ${whenText(Date.parse(r.at), tz)}  ${r.text}`);
    if (kind === 'jobs') return a.jobs.map((j) => `${j.id}  ${j.schedule.every === 'week' ? `weekly (day ${j.schedule.day})` : 'daily'} ${j.schedule.time}  ${j.approved ? (j.paused ? 'paused' : 'on') : 'waiting for Raven'}  ${j.text}`);
    return [];
  }

  // What the notebook panel and Admin see.
  view() {
    const a = this.data();
    return { settings: this.settings(), memories: a.memories, tasks: a.tasks, reminders: a.reminders.filter((r) => !r.done), jobs: a.jobs };
  }
}

module.exports = { Assistant, AssistantError, parseAt, nowText, validZone, LIMITS, DEFAULT_TZ };
