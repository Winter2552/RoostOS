'use strict';

// Uptime history for the status page. Roost keeps a short log of when each
// app went down and came back, plus the stretches when Roost itself was
// running to watch. Nothing is stored per check: a quiet day costs nothing.
//
// Checks are cheap on purpose. Containers are re-read only when Docker
// reports a change (start, stop, crash, health), and apps without a container
// get a web check every few minutes. The file is written when something
// changes and once an hour, so the SSD isn't written to all day.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { target } = require('./docker');

const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 90 * DAY;

class UptimeLog {
  constructor(dataDir, { now = Date.now } = {}) {
    this.file = path.join(dataDir, 'uptime.json');
    this.now = now;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run, or an unreadable file: start a fresh history.
    }
    this.apps = data.apps || {}; // id → { since, outages: [[start, end|null]] }
    this.watched = data.watched || []; // [[start, end]] while Roost was running
    this.host = data.host || ''; // the address people open Roost on, for {host} links
    // Roost was off since the last save, so anything still down then is
    // closed there: we don't know what happened while nobody was watching.
    const lastSeen = this.watched.length ? this.watched[this.watched.length - 1][1] : null;
    for (const a of Object.values(this.apps)) {
      const open = a.outages[a.outages.length - 1];
      if (open && open[1] == null) open[1] = Math.max(open[0], lastSeen || open[0]);
    }
    const t = this.now();
    this.watched.push([t, t]);
    this.prune(t);
    this.save();
  }

  // Record what a check saw. Returns true when the app's state changed.
  observe(id, up, at = this.now()) {
    const a = this.apps[id] || (this.apps[id] = { since: at, outages: [] });
    const last = a.outages[a.outages.length - 1];
    const down = Boolean(last && last[1] == null);
    if (!up && !down) a.outages.push([at, null]);
    else if (up && down) last[1] = at;
    else return false;
    this.save();
    return true;
  }

  // Apps that are no longer checked (unlinked or removed) stop counting.
  forget(ids) {
    let changed = false;
    for (const id of Object.keys(this.apps)) {
      if (ids.includes(id)) continue;
      delete this.apps[id];
      changed = true;
    }
    if (changed) this.save();
  }

  setHost(host) {
    if (!host || host === this.host) return;
    this.host = host;
    this.save();
  }

  heartbeat(at = this.now()) {
    this.watched[this.watched.length - 1][1] = at;
  }

  prune(at) {
    const cutoff = at - KEEP_MS;
    this.watched = this.watched.filter((w) => w[1] >= cutoff);
    for (const a of Object.values(this.apps)) a.outages = a.outages.filter((o) => o[1] == null || o[1] >= cutoff);
  }

  save() {
    this.heartbeat();
    const body = JSON.stringify({ version: 1, host: this.host, watched: this.watched, apps: this.apps });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Saving uptime history failed:', err.message);
    }
  }

  // History for the status page, trimmed to the last `days`. Each entry has
  // the stretches it was watched and its outages; the browser turns them
  // into one bar per day in the viewer's own time zone.
  history(ids, days = 30) {
    const t = this.now();
    this.heartbeat(t);
    const from = t - days * DAY;
    const clip = (list) => list
      .filter((r) => (r[1] == null ? t : r[1]) > from)
      .map(([s, e]) => [Math.max(s, from), e == null ? t : e]);
    const out = {};
    // Roost's own row: running is up, the gaps in between are down.
    const watched = clip(this.watched);
    if (watched.length) {
      const gaps = [];
      for (let i = 1; i < watched.length; i++) {
        if (watched[i][0] > watched[i - 1][1]) gaps.push([watched[i - 1][1], watched[i][0]]);
      }
      out.roost = { watched: [[watched[0][0], t]], outages: gaps };
    }
    for (const id of ids) {
      const a = this.apps[id];
      if (!a) continue;
      out[id] = {
        watched: clip(this.watched.map(([s, e]) => [Math.max(s, a.since), e]).filter(([s, e]) => e > s)),
        outages: clip(a.outages),
      };
    }
    return { now: t, days, apps: out };
  }
}

// Calls onChange whenever Docker reports a container event, so containers are
// re-read only when something happened. Reconnects after a pause if Docker
// goes away. Returns { live() (true while listening), stop() }.
function watchDockerEvents(dockerHost, onChange, { retryMs = 30 * 1000 } = {}) {
  const t = target(dockerHost);
  if (!t) return { live: () => false, stop: () => {} };
  const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
  let req = null;
  let retry = null;
  let stopped = false;
  let live = false;
  const again = () => {
    live = false;
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, retryMs);
    retry.unref();
  };
  function connect() {
    req = http.get({ ...t, path: `/events?filters=${filters}` }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return again(); }
      live = true;
      onChange(); // catch up on anything missed while disconnected
      res.on('data', () => onChange());
      res.on('end', again);
      res.on('error', again);
    });
    req.on('socket', (s) => s.unref());
    req.on('error', again);
  }
  connect();
  return {
    live: () => live,
    stop: () => {
      stopped = true;
      live = false;
      clearTimeout(retry);
      if (req) req.destroy();
    },
  };
}

module.exports = { UptimeLog, watchDockerEvents, DAY };
