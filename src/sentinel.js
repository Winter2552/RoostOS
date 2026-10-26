'use strict';

// Sentinel: a small rule-based watcher for forced entry. It reacts to things
// Roost already sees (requests, failed sign-ins) and does nothing on a timer
// except one cheap daily check, so it costs almost nothing. No AI, no outside
// service: fixed rules you can read.
//
// It watches for:
//   scanner   an address asking for places scanners always try (/.env, /.git,
//             /wp-login.php, ../ ...), three times in ten minutes
//   spray     an address failing to sign in as four or more different names
//   tamper    the admin accounts changed by something other than a Roost screen
//             (checked against a seal kept in its own file)
//
// Modes (Admin → Sentinel):
//   off     watches nothing, bans nothing
//   manual  alerts, and offers a Ban button; you decide
//   auto    alerts and acts on its own: bans the address for 24 hours, and
//           locks Roost down if the admin accounts were tampered with
// Bans only ever apply to connections from outside (HTTPS), never to the home
// address, so Sentinel can't shut Raven out. It keeps its state in
// sentinel.json, separate from the accounts file it protects.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const MODES = ['off', 'manual', 'auto'];
const BAN_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const SCAN_HITS = 3;
const SPRAY_NAMES = 4;
const KEEP_INCIDENTS = 30;
const MAX_TRACKED = 1000;
const SAVE_DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Places nothing in Roost lives at, but scanners always ask for.
const SCANNER_PATH = /^\/(\.(env|git|svn|aws|ssh|ds_store|htaccess|htpasswd)|wp-(login|admin|content|includes|json)|xmlrpc\.php|phpmyadmin|pma\b|myadmin|adminer|admin\.php|cgi-bin|boaform|actuator|vendor\/phpunit|hnap1|owa\/|ecp\/|solr\/|manager\/html|config\.(json|php|yml|yaml|ini)|backup\.(zip|sql|tar|tgz)|setup\.cgi|shell\b|console\b|server-status)/i;
const TRAVERSAL = /(\.\.[\\/]|%2e%2e|%252e|\\x00|%00)/i;

function isScannerRequest(url) {
  const raw = String(url || '').split('?')[0];
  return SCANNER_PATH.test(raw) || TRAVERSAL.test(raw);
}

// A fingerprint of what matters most: who the admins are, their password
// hashes and whether two-step is on. A legitimate change goes through a Roost
// screen, which reseals; anything else shows up as a mismatch.
function fingerprint(db) {
  const admins = db.users
    .filter((u) => u.role === 'admin')
    .map((u) => [u.id, u.username, u.password, u.twoStep ? 1 : 0])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify([admins, db.settings.adminsNeedTwoStep !== false])).digest('hex');
}

function load(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

// For the command line: after a fix made by hand (like reset-two-step), seal
// the accounts as they now are so Sentinel doesn't call it tampering.
function sealFile(dataDir, db) {
  const file = path.join(dataDir, 'sentinel.json');
  const saved = load(file);
  fs.writeFileSync(file, JSON.stringify({ ...saved, seal: fingerprint(db) }));
}

class Sentinel {
  // store: { db }; raise(key, title, detail): an alert on the bell and phone;
  // lockdown(by): shut outside access; skip(ip): true for addresses never banned.
  constructor({ dataDir, store, raise = () => {}, lockdown = () => {}, skip = () => false, now = Date.now, newId = () => crypto.randomBytes(6).toString('hex') }) {
    this.file = path.join(dataDir, 'sentinel.json');
    this.store = store;
    this.raise = raise;
    this.lockdown = lockdown;
    this.skip = skip;
    this.now = now;
    this.newId = newId;
    const saved = load(this.file);
    this.mode = MODES.includes(saved.mode) ? saved.mode : 'manual';
    this.seal = typeof saved.seal === 'string' ? saved.seal : null;
    this.bans = Array.isArray(saved.bans) ? saved.bans.filter((b) => b.until > now()) : [];
    this.incidents = Array.isArray(saved.incidents) ? saved.incidents.slice(-KEEP_INCIDENTS) : [];
    this.scans = new Map(); // ip → times
    this.names = new Map(); // ip → Map(name → time)
    this.timer = null;
    this.daily = null;
  }

  // The first run just seals what is there. After that, a mismatch means the
  // accounts changed behind Roost's back.
  start() {
    this.checkSeal();
    this.daily = setInterval(() => this.checkSeal(), DAY_MS);
    this.daily.unref();
  }

  stop() {
    clearInterval(this.daily);
    this.flush();
  }

  on() {
    return this.mode !== 'off';
  }

  isBanned(ip) {
    if (!this.on() || !ip) return false;
    const t = this.now();
    return this.bans.some((b) => b.ip === ip && b.until > t);
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('Unknown mode');
    this.mode = mode;
    this.saveSoon();
  }

  // ---------- what it sees ----------

  // Called for each request. Cheap: one regex, and only matching requests count.
  request(ip, url) {
    if (!this.on() || !ip || !isScannerRequest(url)) return;
    const t = this.now();
    const hits = [...(this.scans.get(ip) || []).filter((at) => t - at < WINDOW_MS), t];
    this.scans.set(ip, hits);
    this.trim(this.scans);
    if (hits.length === SCAN_HITS) this.incident('scanner', ip, `Asked for places that don't exist in Roost, like ${String(url).split('?')[0].slice(0, 60)}`);
  }

  failedSignIn(ip, name) {
    if (!this.on() || !ip || !name) return;
    const t = this.now();
    const seen = new Map([...(this.names.get(ip) || new Map())].filter(([, at]) => t - at < WINDOW_MS));
    const before = seen.size;
    seen.set(name, t);
    this.names.set(ip, seen);
    this.trim(this.names);
    if (before < SPRAY_NAMES && seen.size >= SPRAY_NAMES) this.incident('spray', ip, `Tried ${seen.size} different usernames in ten minutes`);
  }

  checkSeal() {
    // A Roost screen changed something a moment ago; the reseal is on its way.
    if (!this.on() || this.sealTimer) return;
    const now = fingerprint(this.store.db);
    if (!this.seal) {
      this.seal = now;
      this.saveSoon();
    } else if (this.seal !== now) {
      this.seal = now; // one alert per change, not one a day
      this.saveSoon();
      this.incident('tamper', null, 'The admin accounts changed without going through Roost. If you did not do this by hand, someone may have got in.', true);
    }
  }

  // A change made through a Roost screen (it was recorded in the activity log).
  reseal() {
    if (this.sealTimer) return;
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null;
      this.seal = fingerprint(this.store.db);
      this.saveSoon();
    }, 1500);
    this.sealTimer.unref();
  }

  // ---------- what it does ----------

  incident(kind, ip, detail, serious = false) {
    const inc = { id: this.newId(), at: new Date(this.now()).toISOString(), kind, ip, detail, serious, handled: null };
    this.incidents.push(inc);
    if (this.incidents.length > KEEP_INCIDENTS) this.incidents.shift();
    const what = { scanner: 'A scanner is probing Roost', spray: 'Someone is guessing usernames', tamper: 'Admin accounts were changed behind Roost' }[kind];
    const auto = this.mode === 'auto';
    let home = false;
    if (auto && ip) {
      if (this.ban(ip, kind, true)) inc.handled = 'banned';
      else home = true;
    }
    if (auto && kind === 'tamper') {
      this.lockdown('Sentinel');
      inc.handled = 'locked down';
    }
    const action = home ? ' That address is on your home network, so it was not banned.'
      : inc.handled === 'banned' ? ' Sentinel banned that address for 24 hours.'
      : inc.handled === 'locked down' ? ' Sentinel locked Roost down.'
        : kind === 'tamper' ? ' Open Admin → Security to lock down.' : ' Open Admin → Sentinel to ban it.';
    this.raise(`sec:sentinel:${kind}:${ip || 'accounts'}`, ip ? `${what}: ${ip}` : what, `${detail}${action}`);
    this.saveSoon();
    return inc;
  }

  ban(ip, reason, auto = false) {
    if (net.isIP(ip) === 0) throw new Error('That is not an address');
    if (this.skip(ip)) return false;
    const until = this.now() + BAN_MS;
    const existing = this.bans.find((b) => b.ip === ip);
    if (existing) {
      existing.until = until;
    } else {
      this.bans.push({ ip, reason, auto, at: new Date(this.now()).toISOString(), until });
    }
    for (const inc of this.incidents) if (inc.ip === ip && !inc.handled) inc.handled = 'banned';
    this.saveSoon();
    return true;
  }

  unban(ip) {
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => b.ip !== ip);
    this.saveSoon();
    return this.bans.length !== before;
  }

  trim(map) {
    if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
  }

  view() {
    const t = this.now();
    return {
      mode: this.mode,
      bans: this.bans.filter((b) => b.until > t).map((b) => ({ ip: b.ip, reason: b.reason, auto: b.auto, at: b.at, until: new Date(b.until).toISOString() })),
      incidents: [...this.incidents].reverse(),
    };
  }

  // ---------- saving ----------

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref();
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ mode: this.mode, seal: this.seal, bans: this.bans, incidents: this.incidents }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save Sentinel:', err.message);
    }
  }
}

module.exports = { Sentinel, MODES, isScannerRequest, fingerprint, sealFile, BAN_MS };
