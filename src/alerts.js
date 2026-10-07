'use strict';

// Background watcher: once a minute, checks app containers and drives and keeps
// a short list of alerts in the store. A problem has to last GRACE_MS before it
// becomes an alert, so restarts and app updates stay quiet. The store is only
// written when an alert opens, changes or clears, never on a quiet check.

const { containersFor } = require('./docker');

const DEFAULTS = { alertApps: true, alertDisks: true, alertDiskPct: 90 };
const GRACE_MS = 2 * 60 * 1000;
// A full drive clears a little below the threshold, so it can't flap on and off.
const CLEAR_MARGIN = 3;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 50;

function alertSettings(db) {
  const s = db.settings || {};
  return {
    alertApps: s.alertApps ?? DEFAULTS.alertApps,
    alertDisks: s.alertDisks ?? DEFAULTS.alertDisks,
    alertDiskPct: s.alertDiskPct ?? DEFAULTS.alertDiskPct,
  };
}

function alertsOf(db) {
  if (!Array.isArray(db.alerts)) db.alerts = [];
  return db.alerts;
}

function size(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

const restartsText = (n) => `${n} restart${n === 1 ? '' : 's'}`;

const RANK = { running: 0, paused: 0, unhealthy: 1, restarting: 2, stopped: 3 };

function containerProblem(c) {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'unhealthy' : 'running';
  if (c.state === 'paused') return 'paused'; // paused on purpose, not a fault
  if (c.state === 'restarting') return 'restarting';
  return 'stopped';
}

// What is wrong right now, as key → { title, detail }. `open` is the set of
// keys that already have an alert, for the drive threshold's clear margin.
function findProblems({ apps, docker, disks, settings, open }) {
  const found = new Map();
  if (settings.alertApps && docker) {
    if (docker.error) {
      // No DOCKER_HOST means Roost was set up without container checks.
      if (docker.error !== 'not configured') {
        found.set('docker', { title: "Roost can't reach Docker", detail: 'App checks are paused until it answers again' });
      }
    } else {
      for (const app of apps) {
        const list = containersFor(app, docker.containers);
        if (!list.length) continue; // not installed yet
        const worst = list
          .map((c) => ({ c, p: containerProblem(c) }))
          .sort((x, y) => (RANK[y.p] ?? 0) - (RANK[x.p] ?? 0))[0];
        const { c, p } = worst;
        if (p === 'stopped') {
          found.set(`app:${app.id}`, { title: `${app.name} has stopped`, detail: `${c.name}${c.exitCode ? ` · exit code ${c.exitCode}` : ''}` });
        } else if (p === 'restarting') {
          found.set(`app:${app.id}`, { title: `${app.name} keeps restarting`, detail: `${c.name} · ${restartsText(c.restarts)}` });
        } else if (p === 'unhealthy') {
          found.set(`app:${app.id}`, { title: `${app.name} is unhealthy`, detail: `${c.name} · its health check is failing` });
        }
      }
    }
  }
  if (settings.alertDisks) {
    for (const d of disks) {
      if (d.missing) {
        found.set(`disk-missing:${d.label}`, { title: `${d.label} drive not found`, detail: d.path });
        continue;
      }
      const pct = d.total ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
      const key = `disk:${d.label}`;
      const limit = open.has(key) ? settings.alertDiskPct - CLEAR_MARGIN : settings.alertDiskPct;
      if (pct >= limit) {
        found.set(key, { title: `${d.label} drive is ${pct}% full`, detail: `${size(d.free)} free of ${size(d.total)}`, now: true });
      }
    }
  }
  return found;
}

class Watcher {
  // readContainers: async () => { containers } | { error }
  // readDisks: () => [{ label, path, total, free } | { label, path, missing }]
  // onChange(event, alert): 'raised' | 'resolved' | 'event', for phone push later.
  constructor({ store, readContainers, readDisks, onChange = () => {}, now = Date.now, newId }) {
    this.store = store;
    this.readContainers = readContainers;
    this.readDisks = readDisks;
    this.onChange = onChange;
    this.now = now;
    this.newId = newId;
    this.pending = new Map(); // key → when it was first seen
    this.restarts = new Map(); // container name → restart count last time
    this.checkedAt = null;
    this.busy = null;
  }

  // Runs one check; overlapping calls share the one in flight.
  check() {
    if (!this.busy) this.busy = this.run().finally(() => { this.busy = null; });
    return this.busy;
  }

  async run() {
    const db = this.store.db;
    const settings = alertSettings(db);
    const alerts = alertsOf(db);
    const [docker, disks] = await Promise.all([
      settings.alertApps ? this.readContainers() : null,
      settings.alertDisks ? this.readDisks() : [],
    ]);
    const t = this.now();
    const iso = new Date(t).toISOString();
    const openList = alerts.filter((a) => !a.resolvedAt);
    const open = new Map(openList.map((a) => [a.key, a]));
    const found = findProblems({ apps: db.apps, docker, disks, settings, open: new Set(open.keys()) });
    let changed = false;

    for (const [key, p] of found) {
      const current = open.get(key);
      if (current) {
        if (current.title !== p.title || current.detail !== p.detail) {
          current.title = p.title;
          current.detail = p.detail;
          changed = true;
        }
        continue;
      }
      const first = this.pending.get(key) ?? t;
      if (!p.now && t - first < GRACE_MS) {
        this.pending.set(key, first);
        continue;
      }
      this.pending.delete(key);
      const alert = { id: this.newId(), key, title: p.title, detail: p.detail, startedAt: new Date(first).toISOString(), resolvedAt: null };
      alerts.push(alert);
      changed = true;
      this.onChange('raised', alert);
    }
    for (const key of this.pending.keys()) if (!found.has(key)) this.pending.delete(key);
    for (const a of openList) {
      if (found.has(a.key)) continue;
      a.resolvedAt = iso;
      changed = true;
      this.onChange('resolved', a);
    }

    // A container Docker restarted on its own between checks: worth a note even
    // though it is already back up.
    if (docker && docker.containers && settings.alertApps) {
      for (const app of db.apps) {
        for (const c of containersFor(app, docker.containers)) {
          const before = this.restarts.get(c.name);
          this.restarts.set(c.name, c.restarts);
          if (before !== undefined && c.restarts > before && c.state === 'running') {
            const alert = { id: this.newId(), key: `restart:${c.name}`, title: `${app.name} restarted on its own`, detail: `${c.name} · ${restartsText(c.restarts)} so far`, startedAt: iso, resolvedAt: iso };
            alerts.push(alert);
            changed = true;
            this.onChange('event', alert);
          }
        }
      }
    }

    // Keep open alerts, plus the last week of cleared ones.
    const keep = alerts.filter((a) => !a.resolvedAt || t - Date.parse(a.resolvedAt) < KEEP_MS);
    const cleared = keep.filter((a) => a.resolvedAt);
    const drop = new Set(cleared.slice(0, Math.max(0, cleared.length - KEEP_MAX)));
    const trimmed = keep.filter((a) => !drop.has(a));
    if (trimmed.length !== alerts.length) {
      db.alerts = trimmed;
      changed = true;
    }

    this.checkedAt = iso;
    if (changed) this.store.save();
  }

  start(intervalMs) {
    if (!intervalMs) return;
    const tick = () => this.check().catch((err) => console.error('Alert check failed:', err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Watcher, alertSettings, alertsOf, findProblems, DEFAULTS, GRACE_MS };
