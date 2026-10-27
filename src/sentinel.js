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
//   session   an admin's sign-in cookie used from a different browser or device
//             than it was made on, a sign it was stolen
//   container a container Sentinel has not seen before, or one now running a
//             different image (checked on the container reading Roost already makes)
//
// Modes (Admin → Sentinel):
//   off     watches nothing, bans nothing
//   manual  alerts, and offers a Ban button; you decide
//   auto    alerts and acts on its own: bans the address for 24 hours, signs out
//           a stolen session, and locks Roost down if the admin accounts were
//           tampered with. It never touches containers; it only tells you.
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
const WAVE_ADDRESSES = 5; // different addresses probing within the window = an attack, not background noise
const QUIET = new Set(['scanner', 'spray']); // listed and banned, but only a wave of them reaches the bell
const KEEP_INCIDENTS = 30;
const MAX_TRACKED = 1000;
const SAVE_DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// One-off containers (docker compose run) come and go; they aren't news.
const EPHEMERAL = /-run-[0-9a-f]+$/;
// `docker run` with no name gets two words like nice_fermi. Build steps and
// one-off helpers look like that, so they only count if they stay running.
const RANDOM_NAME = /^[a-z]+_[a-z]+$/;
const UNNAMED_GRACE_MS = 10 * 60 * 1000;
const TRACE_MAX = 400; // recent outside requests kept in memory, never saved
const EVIDENCE_MAX = 40; // requests kept with an incident
const EVIDENCE_KEPT = 10; // incidents that keep their evidence

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

// A request as it goes in a report: no query (that is where tokens and search
// text live), no cookies, no body, and long random path parts (link tokens)
// blanked out.
function redactPath(url) {
  const path = String(url || '').split('?')[0].slice(0, 200);
  return path.split('/').map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) ? '…' : seg)).join('/').slice(0, 120);
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
  constructor({ dataDir, store, raise = () => {}, lockdown = () => {}, endSession = () => {}, skip = () => false, now = Date.now, newId = () => crypto.randomBytes(6).toString('hex') }) {
    this.file = path.join(dataDir, 'sentinel.json');
    this.store = store;
    this.raise = raise;
    this.lockdown = lockdown;
    this.endSession = endSession; // (userId, sessionId)
    this.skip = skip;
    this.now = now;
    this.newId = newId;
    const saved = load(this.file);
    this.mode = MODES.includes(saved.mode) ? saved.mode : 'manual';
    this.seal = typeof saved.seal === 'string' ? saved.seal : null;
    this.bans = Array.isArray(saved.bans) ? saved.bans.filter((b) => b.until > now()) : [];
    // Containers seen and accepted, and ones flagged but not yet accepted (so a restart doesn't flag them again).
    this.known = saved.known && typeof saved.known === 'object' ? saved.known : null;
    this.unknown = saved.unknown && typeof saved.unknown === 'object' ? saved.unknown : {};
    this.flaggedSessions = new Set();
    this.incidents = Array.isArray(saved.incidents) ? saved.incidents.slice(-KEEP_INCIDENTS) : [];
    this.recent = []; // the last few outside requests, for the evidence in a report
    this.scans = new Map(); // ip → times
    this.names = new Map(); // ip → Map(name → time)
    this.unnamed = new Map(); // random-named container → when first seen (memory only)
    this.lastList = null;
    this.probes = new Map(); // ip → time of its latest quiet incident, for spotting a wave
    this.waveAt = 0;
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
    clearTimeout(this.unnamedTimer);
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

  // Remembers an outside request (kept in memory only). The caller fills in the
  // status when the answer is sent.
  trace(ip, method, url, userAgent = '') {
    if (!this.on()) return null;
    const entry = { at: new Date(this.now()).toISOString(), ip, method: String(method || ''), path: redactPath(url), status: null, ua: String(userAgent).slice(0, 80) };
    this.recent.push(entry);
    if (this.recent.length > TRACE_MAX) this.recent.shift();
    return entry;
  }

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

  // An admin's sign-in cookie used from a different browser or device than it
  // was made on. → true when Sentinel ended that sign-in (auto mode), so the
  // request in flight is refused too.
  sessionMismatch({ userId, username, sessionId, was, now, ip }) {
    if (!this.on() || this.flaggedSessions.has(sessionId)) return false;
    this.flaggedSessions.add(sessionId);
    if (this.flaggedSessions.size > MAX_TRACKED) this.flaggedSessions.delete(this.flaggedSessions.values().next().value);
    const inc = this.incident('session', ip, `The sign-in cookie for ${username}, made on ${was}, is being used from ${now}. It may have been stolen.`, true, { userId, sessionId });
    if (this.mode !== 'auto') return false;
    this.endSession(userId, sessionId);
    inc.handled = inc.handled ? `${inc.handled}, signed out` : 'signed out';
    this.saveSoon();
    return true;
  }

  // The containers Docker reports. The first look is the baseline; after that,
  // a new name or a changed image is an incident until you trust it.
  containers(list) {
    if (!this.on() || !Array.isArray(list)) return;
    const seen = {};
    for (const c of list) if (c.name && !EPHEMERAL.test(c.name)) seen[c.name] = c.imageRef || c.image || '';
    if (!this.known) {
      this.known = seen;
      this.saveSoon();
      return;
    }
    this.lastList = list;
    for (const name of this.unnamed.keys()) if (!(name in seen)) this.unnamed.delete(name);
    for (const [name, ref] of Object.entries(seen)) {
      const was = this.known[name];
      if (was === ref || this.unknown[name] === ref) continue;
      if (was === undefined && RANDOM_NAME.test(name)) {
        const first = this.unnamed.get(name);
        if (first === undefined) {
          this.unnamed.set(name, this.now());
          this.recheckLater();
          continue;
        }
        if (this.now() - first < UNNAMED_GRACE_MS) continue;
      }
      this.unknown[name] = ref;
      this.incident('container', null, was === undefined ? `A new container is running: ${name} (${ref}). If you did not install it, remove it in ZimaOS and run the recovery steps.` : `${name} now runs a different image: ${was} → ${ref}.`, was !== undefined, { name, ref });
    }
  }

  // Docker only reports changes, so look again once the grace time is up.
  recheckLater() {
    if (this.unnamedTimer) return;
    this.unnamedTimer = setTimeout(() => {
      this.unnamedTimer = null;
      if (this.lastList) this.containers(this.lastList);
    }, UNNAMED_GRACE_MS + 1000);
    this.unnamedTimer.unref();
  }

  // "I know that one": accepts a container (or its new image) as normal.
  trust(incident) {
    if (!incident || incident.kind !== 'container' || !incident.target) return false;
    const { name, ref } = incident.target;
    this.known = { ...(this.known || {}), [name]: ref };
    delete this.unknown[name];
    incident.handled = 'trusted';
    this.saveSoon();
    return true;
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

  incident(kind, ip, detail, serious = false, target = null) {
    // What the report will show: that address's last requests, or, with no
    // address (tampering), the most recent changes anyone made from outside.
    const evidence = (ip ? this.recent.filter((r) => r.ip === ip) : this.recent.filter((r) => r.method !== 'GET')).slice(-EVIDENCE_MAX).map((r) => ({ ...r }));
    const inc = { id: this.newId(), at: new Date(this.now()).toISOString(), kind, ip, detail, serious, handled: null, evidence, target };
    this.incidents.push(inc);
    if (this.incidents.length > KEEP_INCIDENTS) this.incidents.shift();
    for (const old of this.incidents.slice(0, -EVIDENCE_KEPT)) delete old.evidence;
    const what = { wave: 'Many addresses are attacking Roost', scanner: 'A scanner is probing Roost', spray: 'Someone is guessing usernames', tamper: 'Admin accounts were changed behind Roost', session: 'A sign-in looks stolen', container: 'An unexpected container' }[kind];
    const auto = this.mode === 'auto';
    let home = false;
    if (auto && ip) {
      if (this.ban(ip, kind, true)) inc.handled = 'banned';
      else home = true;
    }
    if (auto && (kind === 'tamper' || kind === 'wave')) {
      this.lockdown('Sentinel');
      inc.handled = 'locked down';
    }
    const action = kind === 'session' ? (auto ? ' Sentinel signed it out.' : ' Open Admin → Sentinel to sign it out.')
      : kind === 'container' ? ' Open Admin → Sentinel to trust it if it is yours.'
      : home ? ' That address is on your home network, so it was not banned.'
      : inc.handled === 'banned' ? ' Sentinel banned that address for 24 hours.'
      : inc.handled === 'locked down' ? ' Sentinel locked Roost down.'
        : kind === 'tamper' || kind === 'wave' ? ' Open Admin → Security to lock down.' : ' Open Admin → Sentinel to ban it.';
    if (QUIET.has(kind)) {
      this.noteProbe(ip, kind);
    } else {
      this.raise(`sec:sentinel:${kind}:${ip || (target && target.name) || 'accounts'}`, ip ? `${what}: ${ip}` : what, `${detail}${action}`);
    }
    this.saveSoon();
    return inc;
  }

  // Mild probing is only listed. Several different addresses within ten
  // minutes is an attack: one alert, and in auto mode, lockdown.
  noteProbe(ip, kind) {
    const t = this.now();
    this.probes.set(ip, t);
    for (const [addr, at] of this.probes) if (t - at >= WINDOW_MS) this.probes.delete(addr);
    if (this.probes.size < WAVE_ADDRESSES || t - this.waveAt < WINDOW_MS) return;
    this.waveAt = t;
    this.incident('wave', null, `${this.probes.size} different addresses probed or guessed at Roost within ten minutes (latest: ${kind} from ${ip}).`, true);
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
      incidents: [...this.incidents].reverse().map(({ evidence, target, ...rest }) => ({ ...rest, report: Boolean(evidence), canTrust: rest.kind === 'container' && !rest.handled, canEnd: rest.kind === 'session' && !rest.handled?.includes('signed out') })),
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
      fs.writeFileSync(tmp, JSON.stringify({ mode: this.mode, seal: this.seal, bans: this.bans, incidents: this.incidents, known: this.known, unknown: this.unknown }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save Sentinel:', err.message);
    }
  }
}

// The incident report an admin downloads and hands to Claude: enough to work
// out how someone got in, with nothing that could be used to get in again.
function buildReport({ incident, entries = [], users = [], settings = {}, version = '', mode = '', bans = [], now = new Date() }) {
  const at = Date.parse(incident.at);
  const near = entries.filter((e) => Math.abs(Date.parse(e.at) - at) <= 15 * 60 * 1000).slice(-60);
  const rows = (list, cols) => (list.length ? list.map((r) => `| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '/')).join(' | ')} |`).join('\n') : '_none kept_');
  const head = (cols) => `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
  const evidence = incident.evidence || [];
  return [
    '# Roost incident report',
    '',
    `Made ${now.toISOString()} · Roost ${version} · Sentinel ${mode}`,
    '',
    '## The incident',
    `- What: ${incident.kind}${incident.serious ? ' (serious)' : ''}`,
    `- When: ${incident.at}`,
    `- From: ${incident.ip || 'no address (the accounts changed behind Roost)'}`,
    `- Seen: ${incident.detail}`,
    `- Handled: ${incident.handled || 'not yet'}`,
    '',
    incident.ip ? '## That address\'s last requests from outside' : '## The latest changes (POST/PUT/PATCH/DELETE) from outside',
    head(['at', 'ip', 'method', 'path', 'status', 'ua']),
    rows(evidence, ['at', 'ip', 'method', 'path', 'status', 'ua']),
    '',
    '## Activity log within 15 minutes',
    head(['at', 'type', 'actor', 'target', 'detail', 'ip']),
    rows(near, ['at', 'type', 'actor', 'target', 'detail', 'ip']),
    '',
    '## Accounts now',
    head(['username', 'role', 'two-step']),
    rows(users.map((u) => ({ username: u.username, role: u.role, 'two-step': u.twoStep ? 'on' : 'off' })), ['username', 'role', 'two-step']),
    '',
    '## State',
    `- Lockdown: ${settings.lockdown ? `on since ${settings.lockdown.at} (${settings.lockdown.by})` : 'off'}`,
    `- Public Nest links: ${settings.publicLinks === false ? 'off' : 'on'}`,
    `- Admins must use two-step: ${settings.adminsNeedTwoStep === false ? 'no' : 'yes'}`,
    `- Banned addresses: ${bans.length ? bans.map((b) => b.ip).join(', ') : 'none'}`,
    '',
    '---',
    'Left out on purpose: passwords and their hashes, cookies, request bodies, query strings, link tokens and every stored secret.',
    'Hand this file to Claude in the Roost project thread to work out the cause and fix it.',
    '',
  ].join('\n');
}

module.exports = { buildReport, redactPath, Sentinel, MODES, isScannerRequest, fingerprint, sealFile, BAN_MS };
