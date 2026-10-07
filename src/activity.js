'use strict';

// Admin activity log: sign-ins, failed attempts, user and storage changes.
// Kept in its own file next to roost.json so ordinary saves stay small. Entries
// are held in memory and written at most once every few seconds, so a burst of
// failed sign-ins doesn't rewrite the file hundreds of times.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 1000;
const SAVE_DELAY_MS = 3000;

// Which filter button each event type belongs to on the Admin page.
const KINDS = {
  'sign-in': 'sign-ins',
  'sign-out': 'sign-ins',
  setup: 'sign-ins',
  'sign-in-failed': 'failed',
  'password-changed': 'users',
  'user-added': 'users',
  'user-changed': 'users',
  'user-removed': 'users',
  'user-joined': 'users',
  'invite-created': 'users',
  'invite-removed': 'users',
  'reset-link-created': 'users',
  'password-reset': 'users',
  'two-step-on': 'users',
  'two-step-off': 'users',
  'storage-requested': 'storage',
  'storage-approved': 'storage',
  'storage-declined': 'storage',
  'apps-changed': 'settings',
  'settings-changed': 'settings',
};
const FILTERS = ['sign-ins', 'failed', 'users', 'storage', 'settings'];

class ActivityLog {
  constructor(dataDir, { saveDelayMs = SAVE_DELAY_MS, max = MAX_ENTRIES } = {}) {
    this.file = path.join(dataDir, 'activity.json');
    this.saveDelayMs = saveDelayMs;
    this.max = max;
    this.timer = null;
    this.entries = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved.entries)) this.entries = saved.entries.slice(-max);
    } catch {
      // No log yet (or an unreadable one): start empty rather than refuse to run.
    }
    this.seq = this.entries.length ? this.entries[this.entries.length - 1].seq : 0;
  }

  // actor and target are usernames; ip is where the request came from.
  add(type, { actor = null, target = null, detail = '', ip = '' } = {}) {
    const entry = { seq: ++this.seq, at: new Date().toISOString(), type, actor, target, detail, ip };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
      this.timer.unref();
    }
    return entry;
  }

  // Newest first, `limit` at a time; pass the last seq you saw as `before`.
  page({ before = Infinity, filter = '', limit = 50 } = {}) {
    const out = [];
    let more = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.seq >= before || (filter && KINDS[e.type] !== filter)) continue;
      if (out.length === limit) { more = true; break; }
      out.push({ ...e, kind: KINDS[e.type] });
    }
    return { entries: out, more };
  }

  // Writes only when something is waiting. A failed write is reported, never
  // allowed to take the server down: the log is a record, not account data.
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save the activity log:', err.message);
    }
  }
}

// The address a request came from. Behind a tunnel or reverse proxy every
// request arrives from the proxy, so with trustProxy on, use the address the
// proxy appended last to X-Forwarded-For (earlier entries can be faked by the
// visitor). Off by default, because then anyone could send that header.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

module.exports = { ActivityLog, clientIp, FILTERS, MAX_ENTRIES };
