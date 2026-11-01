'use strict';

// Cockerel: Raven's personal agent. He lives in his own VM (see cockerel-vm/);
// this is Roost's side of the link. Roost sends him chat messages and phone
// alerts over a signed local request, and he reports back (activity, jobs,
// questions) with the same signature. Nothing here polls: he is only woken by
// a chat message, a movie request or an alert.

const crypto = require('crypto');

const LOG_MAX = 200;
const JOB_MAX = 30;
const SKEW_S = 120;
const GB = 1024 ** 3;
const FILE_MAX = 20 * 1024 * 1024; // the biggest file he may send to Nest

const DEFAULTS = { sizeGb: 5, dayGb: 20 };

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

class Cockerel {
  constructor({ store, newId, now = Date.now, fetchImpl = fetch, seal = (t) => t, open = (b) => b }) {
    this.store = store;
    this.seal = seal;
    this.open = open;
    this.newId = newId;
    this.now = now;
    this.fetchImpl = fetchImpl;
  }

  config() {
    const c = this.store.db.settings.cockerel || {};
    return {
      url: c.url || '',
      secret: (c.secret && this.open(c.secret)) || '',
      paused: c.paused === true,
      sizeGb: Number.isFinite(c.sizeGb) ? c.sizeGb : DEFAULTS.sizeGb,
      dayGb: Number.isFinite(c.dayGb) ? c.dayGb : DEFAULTS.dayGb,
    };
  }

  enabled() {
    const c = this.config();
    return Boolean(c.url && c.secret);
  }

  // What Admin sees: never the secret itself.
  view() {
    const c = this.config();
    return { url: c.url, hasSecret: Boolean(c.secret), paused: c.paused, sizeGb: c.sizeGb, dayGb: c.dayGb };
  }

  save(changes) {
    const s = this.store.db.settings;
    const next = { ...(s.cockerel || {}) };
    if ('url' in changes) next.url = changes.url;
    if ('secret' in changes) next.secret = changes.secret ? this.seal(changes.secret) : '';
    if ('paused' in changes) next.paused = changes.paused === true;
    if ('sizeGb' in changes) next.sizeGb = changes.sizeGb;
    if ('dayGb' in changes) next.dayGb = changes.dayGb;
    s.cockerel = next;
    this.store.save();
  }

  data() {
    const d = this.store.db;
    if (!d.cockerel || typeof d.cockerel !== 'object') d.cockerel = {};
    const c = d.cockerel;
    if (!Array.isArray(c.log)) c.log = [];
    if (!Array.isArray(c.jobs)) c.jobs = [];
    if (!c.day) c.day = { date: '', bytes: 0 };
    return c;
  }

  today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  dayBytes() {
    const day = this.data().day;
    return day.date === this.today() ? day.bytes : 0;
  }

  // ---------- signing ----------
  sign(ts, body) {
    return crypto.createHmac('sha256', this.config().secret).update(`${ts}\n${body}`).digest('hex');
  }

  headers(body) {
    const ts = String(Math.floor(this.now() / 1000));
    return { 'content-type': 'application/json', 'x-roost-ts': ts, 'x-roost-sig': this.sign(ts, body) };
  }

  // True when a request from the VM carries a fresh, correct signature.
  verify(headers, body) {
    if (!this.enabled()) return false;
    const ts = String(headers['x-roost-ts'] || '');
    const sig = String(headers['x-roost-sig'] || '');
    if (!/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
    if (Math.abs(Math.floor(this.now() / 1000) - Number(ts)) > SKEW_S) return false;
    const want = Buffer.from(this.sign(ts, body), 'hex');
    return crypto.timingSafeEqual(want, Buffer.from(sig, 'hex'));
  }

  // ---------- the VM ----------
  async call(method, path, payload, timeoutMs = 15000) {
    if (!this.enabled()) throw new CockerelError('Cockerel is not set up yet', 409);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    let res;
    try {
      res = await this.fetchImpl(this.config().url.replace(/\/+$/, '') + path, {
        method,
        headers: this.headers(body),
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CockerelError("Cockerel isn't answering. Is his VM running?", 502);
    }
    let out = {};
    try { out = await res.json(); } catch { /* an empty answer is fine */ }
    if (!res.ok) throw new CockerelError(clip(out.error, 200) || `Cockerel answered ${res.status}`, 502);
    return out;
  }

  // Live health from the VM (CPU, memory, disk, VPN). Only asked for when Admin
  // or the chat panel is open.
  async status() {
    try {
      return { reachable: true, ...(await this.call('GET', '/status', undefined, 4000)) };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  // ---------- the activity feed ----------
  add(entry) {
    const c = this.data();
    const item = { id: this.newId(), at: new Date(this.now()).toISOString(), kind: clip(entry.kind, 12) || 'note', text: clip(entry.text, 2000) };
    if (entry.options) item.options = entry.options.slice(0, 3).map((o) => clip(o, 40));
    if (entry.askId) item.askId = clip(entry.askId, 60);
    if (entry.file) item.file = { id: clip(entry.file.id, 60), name: clip(entry.file.name, 120), size: Math.max(0, Number(entry.file.size) || 0) };
    c.log.push(item);
    if (c.log.length > LOG_MAX) c.log.splice(0, c.log.length - LOG_MAX);
    this.store.save();
    return item;
  }

  setJob(job) {
    const c = this.data();
    const id = clip(job.id, 60);
    if (!id) return null;
    let j = c.jobs.find((x) => x.id === id);
    if (!j) {
      j = { id, title: clip(job.title, 120), state: 'Requested', progress: 0, at: new Date(this.now()).toISOString() };
      c.jobs.push(j);
      if (c.jobs.length > JOB_MAX) c.jobs.splice(0, c.jobs.length - JOB_MAX);
    }
    if (job.title) j.title = clip(job.title, 120);
    if (STATES.includes(job.state)) j.state = job.state;
    if (Number.isFinite(job.progress)) j.progress = Math.max(0, Math.min(100, Math.round(job.progress)));
    if (job.requester) j.requester = clip(job.requester, 60);
    j.updatedAt = new Date(this.now()).toISOString();
    this.store.save();
    return j;
  }

  // ---------- the size limit ----------
  // 'auto' under both limits, 'ask' when Raven should decide. Roost keeps the
  // day's tally, so the VM can't lose count by restarting.
  check(bytes) {
    const c = this.config();
    if (!Number.isFinite(bytes) || bytes <= 0) return { decision: 'ask', reason: 'size unknown' };
    if (bytes > c.sizeGb * GB) return { decision: 'ask', reason: `over the ${c.sizeGb} GB limit for one download` };
    if (this.dayBytes() + bytes > c.dayGb * GB) return { decision: 'ask', reason: `would pass ${c.dayGb} GB for today` };
    return { decision: 'auto' };
  }

  // Counts a download against today's allowance once it is going ahead.
  spend(bytes) {
    const day = this.data().day;
    if (day.date !== this.today()) { day.date = this.today(); day.bytes = 0; }
    day.bytes += Math.max(0, Math.round(bytes));
    this.store.save();
  }

  // ---------- waking him ----------
  // Called for every admin phone alert (movie requests, Sentinel). Fire and
  // forget; a stopped VM just misses it, and the alert is still on the phone.
  event(message) {
    if (!this.enabled() || this.config().paused) return;
    const e = { title: clip(message.title, 120), body: clip(message.body, 300), tag: clip(message.tag, 80) };
    this.call('POST', '/event', e, 8000).catch(() => {});
    this.add({ kind: 'event', text: `${e.title}: ${e.body}` });
  }
}

const STATES = ['Requested', 'Finding', 'Downloading', 'Added', 'Failed'];

class CockerelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

module.exports = { Cockerel, CockerelError, DEFAULTS, STATES, GB, FILE_MAX };
