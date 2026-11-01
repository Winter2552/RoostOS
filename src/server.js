'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, DEFAULT_APPS } = require('./store');
const { Assistant, AssistantError } = require('./assistant');
const { Cockerel, CockerelError, GB: COCKEREL_GB, FILE_MAX: COCKEREL_FILE_MAX } = require('./cockerel');
const birdhouse = require('./birdhouse');
const birdhouseAi = require('./birdhouse-ai');
const secrets = require('./secrets');
const birdhouseModel = require('../public/birdhouse-model');
const { hashPassword, verifyPassword, verifyAgainstNobody, Sessions, RateLimiter, deviceName, SESSION_TTL_MS } = require('./auth');
const storage = require('./storage');
const links = require('./links');
const mail = require('./mail');
const emailTemplate = require('./email-template');
const setup = require('./setup');
const backup = require('./backup');
const selfUpdate = require('./self-update');
const nestDrive = require('./nest-drive');
const { parseDisks, readDisks, CpuMeter, serverHealth } = require('./status');
const { listContainers, containersFor, restartContainer } = require('./docker');
const { UpdateChecker } = require('./updates');
const { DriveHealth } = require('./smart');
const { Sensors, priceOf, money } = require('./sensors');
const { HealthHistory } = require('./health-history');
const driveTrends = require('./drive-trends');
const { OutsideServices } = require('./outside');
const remoteAccess = require('./remote');
const { Coffee, validSecret, newSecret } = require('./coffee');
const galaxies = require('./galaxies');
const wireguard = require('./wireguard');
const templates = require('./templates');
const { cleanSchedule, isDue } = require('./schedule');
const { CertManager, validDomain } = require('./tls');
const twoStep = require('./twostep');
const { qrSvg } = require('./qr');
const { ActivityLog, clientIp, FILTERS } = require('./activity');
const { HttpError, send, readJson, readRaw, str } = require('./http');
const { Nest, disposition, CHUNK: NEST_CHUNK } = require('./nest');
const { Readable } = require('stream');
const family = require('./family');
const releases = require('./releases');
const zip = require('./zip');
const restore = require('./restore');
const { Glint } = require('./glint');
const { Importer } = require('./glint-import');
const { NestImporter } = require('./nest-import');
const { PhotoBackup } = require('./photo-backup');
const { ImmichApi } = require('./immich');
const { Assets } = require('./assets');
const { TrafficMeter } = require('./traffic');
const { createSearch, nestSource } = require('./search');
const { Jellyfin, PREFIX: JELLYFIN_PREFIX, OPENER_HTML } = require('./jellyfin');
const roostflix = require('./roostflix');
const { UptimeLog, watchDockerEvents } = require('./uptime');
const { Watcher, alertSettings, alertsOf } = require('./alerts');
const { AccountGuard, SecurityWatch, securityChecks, isPrivateIp } = require('./security');
const { Sentinel, MODES: SENTINEL_MODES, buildReport } = require('./sentinel');
const { checkPorts } = require('./portcheck');
const codeCheck = require('./code-check');
const { Push } = require('./push');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const RELEASES = releases.load(RELEASES_DIR);
const APP_VERSION = RELEASES.length ? RELEASES[0].version : '0.1';
const COOKIE = 'roost_session';
// Remembers a device that passed two-step sign-in, so it isn't asked again for 30 days.
const TRUST_COOKIE = 'roost_trust';
// Roost's own pages: scripts only from Roost itself, so a script injected into
// a page (a file name, a comment) can't run. Styles allow inline because the
// app sets styles from script; Google Fonts is the one outside host.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRUSTED = 20;
// A password that was right waits this long for its code.
const CODE_WAIT_MS = 5 * 60 * 1000;
const CODE_TRIES = 5;
const ICONS = ['play', 'orbit', 'folder', 'spark', 'grid', 'cloud', 'music', 'home'];

// ---------- helpers ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = cookieValue(part.slice(i + 1));
  }
  return out;
}

function cookieValue(raw) {
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

// Every value sent for one cookie name. A browser can hold the same cookie
// twice (one for the exact address, one for the whole domain) and sends both.
function cookieValues(req, name) {
  const out = [];
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(cookieValue(part.slice(i + 1)));
  }
  return out;
}

// `domain` makes the cookie count on every name under the domain (nova.<domain>
// for Coffee Galaxy); without it, only on the exact address.
function sessionCookie(token, secure, domain = '') {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/${domain ? `; Domain=${domain}` : ''}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function trustCookie(token, secure) {
  const maxAge = token ? Math.floor(TRUST_TTL_MS / 1000) : 0;
  return `${TRUST_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function validUsername(u) {
  return /^[a-z0-9._-]{2,32}$/.test(u);
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 200;
}

// App links may use {host} so they follow whatever address you opened Roost on.
// Apps built into Roost link to their page, e.g. #/nest.
function validAppUrl(u) {
  if (u === '' || builtIn(u)) return true;
  try {
    const parsed = new URL(u.replace(/\{host\}/g, 'localhost'));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function builtIn(url) {
  return /^#\/[a-z]+$/.test(url);
}

// Admins must use two-step sign-in unless an admin turns that off.
function adminsNeedTwoStep(db) {
  return db.settings.adminsNeedTwoStep !== false;
}

function twoStepNeeded(db, u) {
  return u.role === 'admin' && adminsNeedTwoStep(db) && !u.twoStep;
}

function publicUser(db, u) {
  const required = u.role === 'admin' && adminsNeedTwoStep(db);
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    apps: u.apps,
    // This person's own dashboard layout: app ids in their order, and their starred apps.
    appOrder: u.appOrder || [],
    favourites: u.favourites || [],
    ...(u.role === 'guest' ? { guestUntil: u.guestUntil } : {}),
    email: u.email || '',
    createdAt: u.createdAt,
    // Releases this person has not seen yet, for the What's new sheet (guests just pass through).
    whatsNew: u.role === 'guest' ? [] : releases.unseenFor(RELEASES, u),
    family: family.isMember(db, u),
    twoStep: {
      on: Boolean(u.twoStep),
      required,
      // Offer it once after sign-in to people who don't have to use it.
      // Guests are only passing through, so they aren't asked.
      offer: !u.twoStep && !required && !u.twoStepSkipped && u.role !== 'guest',
      recoveryLeft: u.twoStep ? u.twoStep.recovery.length : 0,
    },
  };
}

// Guests sign in until their pass ends, then Roost turns them away.
const GUEST_MAX_MS = 366 * 24 * 60 * 60 * 1000;

function cleanRole(v) {
  return v === 'admin' || v === 'guest' ? v : 'user';
}

function guestEnded(user) {
  return user.role === 'guest' && !(Date.parse(user.guestUntil) > Date.now());
}

// Admins see every app. Someone with a chosen list sees what is on it. Someone
// with no list sees everything except apps marked adminOnly (still being tried
// out), which an admin can switch on for them in their app list.
function visibleApps(db, user) {
  if (user.role === 'admin') return db.apps;
  return Array.isArray(user.apps) ? db.apps.filter((a) => user.apps.includes(a.id)) : db.apps.filter((a) => !a.adminOnly);
}

// A list of app ids from the client, kept to apps that exist, without repeats.
function appIds(db, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of apps');
  const known = new Set(db.apps.map((a) => a.id));
  return [...new Set(list)].filter((id) => known.has(id));
}

// True when the browser reached Roost over HTTPS: directly, or through a
// trusted proxy such as Cloudflare, which talks HTTPS to the browser.
function isSecure(req, trustProxy) {
  return !!req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

// Addresses on the home network, which Roost can also reach from inside its
// container. A public domain (through a tunnel) isn't, so it's never used
// for background checks.
function localHost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || !host.includes('.') || /\.(local|lan|home\.arpa)$/.test(host);
}

function requestHost(req) {
  const host = String(req.headers.host || 'localhost');
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

// An app's reachability: built-in apps are up whenever Roost is.
function appProbe(app, host, timeoutMs) {
  if (!app.url) return { state: 'unset' };
  if (builtIn(app.url)) return { state: 'online', ms: 0 };
  return timedProbe(app.url.replace(/\{host\}/g, host), timeoutMs);
}

async function timedProbe(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    // Any HTTP answer at all (even a redirect or 401) means the app is up.
    await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return { state: 'online', ms: Date.now() - started };
  } catch {
    return { state: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- server ----------

function createServer({ dataDir, nestDir, backupDir = '', secureCookies = false, probeTimeoutMs = 2500, disks, dockerHost, roostContainer = 'roost', smartDir = '', appToken = '', trustProxy = false, tls: tlsOptions = {}, outsideOptions = {}, remoteOptions = {}, coffeeOptions = {}, activitySaveDelayMs, sendMail = mail.send, maxFailedSignIns = 10, registryFetch, uptimeCheckMs = 5 * 60 * 1000, scheduleCheckMs = 20 * 1000, alertIntervalMs = 60 * 1000, readContainers, push: pushOptions = {}, portOptions = {}, aiBase } = {}) {
  const store = new Store(dataDir);
  const certs = new CertManager({ dataDir, getConfig: () => store.db.settings.tls, ...tlsOptions });
  // The few outside services Roost leans on, for the admin's status page.
  const outside = new OutsideServices({ tokenOf: () => (store.db.settings.tls || {}).token || '', ...outsideOptions });
  // Reaching Roost from outside through Cloudflare: real visitor addresses,
  // the domain's A record, and the end-to-end test.
  const remote = new remoteAccess.RemoteAccess({
    getSettings: () => store.db.settings.remote,
    patch: (fields) => { store.db.settings.remote = { ...store.db.settings.remote, ...fields }; store.saveSoon(); },
    getTls: () => store.db.settings.tls,
    // Coffee Galaxy answers on nova.<domain>, so that name needs the same record.
    extraNames: () => {
      const { domain } = store.db.settings.tls || {};
      const on = (store.db.settings.coffee || {}).enabled || (store.db.settings.galaxies || []).some((g) => g.enabled);
      return domain && on ? [`nova.${domain}`] : [];
    },
    ...remoteOptions,
  });
  // Coffee Galaxy lives on another server, reached over a WireGuard link Roost makes.
  const link = new wireguard.WireGuard(path.join(dataDir, 'wireguard'), coffeeOptions.wireguard);
  const coffee = new Coffee({
    getConfig: () => store.db.settings.coffee,
    getDomain: () => (store.db.settings.tls || {}).domain,
    ...(coffeeOptions.target ? { target: coffeeOptions.target } : {}),
  });
  const activity = new ActivityLog(dataDir, { saveDelayMs: activitySaveDelayMs });
  const traffic = new TrafficMeter(dataDir);
  const assets = new Assets(PUBLIC_DIR);
  const releaseImages = new Assets(path.join(RELEASES_DIR, 'img'));
  // Nest and Glint used to be outside apps with no link; they are built in now.
  let linked = false;
  for (const [id, url] of [['nest', '#/nest'], ['glint', '#/glint']]) {
    const app = store.db.apps.find((a) => a.id === id);
    if (app && !app.url) {
      app.url = url;
      linked = true;
    }
  }
  // Birdhouse arrives as a built-in app once; an admin can remove it after.
  if (!store.db.settings.birdhouseAdded) {
    store.db.settings.birdhouseAdded = true;
    if (!store.db.apps.some((a) => a.id === 'birdhouse')) store.db.apps.push({ ...DEFAULT_APPS.find((a) => a.id === 'birdhouse') });
    linked = true;
  }
  // Cockerel too (admins only, and only Raven can ever be an admin of him).
  if (!store.db.settings.cockerelAdded) {
    store.db.settings.cockerelAdded = true;
    if (!store.db.apps.some((a) => a.id === 'cockerel')) store.db.apps.push({ ...DEFAULT_APPS.find((a) => a.id === 'cockerel') });
    linked = true;
  }
  if (linked) store.save();
  let designing = false; // one Claude design at a time
  const priceAsked = new Map(); // when each person last pressed Fetch price
  // Roostflix, the look Roost gives Jellyfin's page, is on unless switched off.
  const jellyfin = new Jellyfin(
    () => store.db.settings.jellyfin,
    () => (store.db.settings.roostflix === false ? null : (html) => roostflix.skinPage(html, (f) => { const a = assets.load(f); return a && a.hash; })),
  );
  // Jellyfin sign-ins still being made for a Roost sign-in, by its id.
  const jellyfinLinks = new Map();
  const sessions = new Sessions(path.join(dataDir, 'sessions.json'), (s) => {
    if (s.jf) jellyfin.logout(s.jf.token).catch(() => {});
  });
  const limiter = new RateLimiter(maxFailedSignIns);
  const guard = new AccountGuard();
  // Sign-ins waiting for a code, and authenticator secrets waiting to be
  // confirmed. Both are short-lived, so they stay in memory.
  const pendingCodes = new Map();
  const pendingSetups = new Map();
  const cpu = new CpuMeter();
  // When each app was last restarted from the status page, to stop double taps.
  const restartedAt = new Map();
  // Drives shown on the status page. Without a list, show the system drive and
  // the drive Roost keeps its data on (the same drive is only listed once).
  const diskList = disks && disks.length ? disks : [{ label: 'System', path: '/' }, { label: 'Data', path: dataDir }];
  const db = () => store.db;
  const updates = new UpdateChecker({ dataDir, dockerHost, fetch: registryFetch });
  // SMART readings the roost-smart helper leaves behind; null when it isn't set up.
  const driveHealth = new DriveHealth(smartDir);
  // CPU power and heat from the same helper; null when it isn't set up.
  const sensors = new Sensors(smartDir);

  // The family space is stored in Nest like one more user (see src/family.js).
  family.familyOf(db());
  const nest = new Nest({
    dir: nestDir || path.join(dataDir, 'nest'),
    dbFile: path.join(dataDir, 'nest.db'),
    users: (id) => (id === family.FAMILY_ID ? family.familyOf(db()) : db().users.find((u) => u.id === id) || null),
    limitOf: (user) => {
      const s = storage.storageOf(db(), user);
      return { limitBytes: s.limitBytes, otherBytes: s.usedBytes - (s.usage.nest || 0) };
    },
    onUsage: (user, bytes) => {
      user.storageUsage = { ...user.storageUsage, nest: bytes };
      store.saveSoon();
    },
    // Public file links: the admin switch, the address links start with, and the activity log.
    publicOn: () => db().settings.publicLinks !== false,
    // Without a saved public address the Host header is only believed when it is the
    // Roost domain or a home address; anything else is a visitor's say-so.
    baseUrl: (req) => {
      const saved = (db().settings.publicUrl || '').replace(/\/+$/, '');
      if (saved) return saved;
      const host = requestHost(req);
      const domain = (db().settings.tls || {}).domain;
      if (localHost(host) || knownDomain(req)) return `${secure(req) ? 'https' : 'http'}://${host}`;
      return domain ? `https://${domain}` : `http://localhost`;
    },
    isSecure: (req) => secure(req),
    audit: (req, type, user, detail) => record(req, type, { actor: user.username, detail }),
  });
  // The backup drive, read-only: for browsing and restoring from backups.
  const backups = new restore.Backups(backupDir);
  // The one restore into Nest that may be running, and how it is going.
  let restoreJob = null;
  // The Roost user whose Nest files a backed-up path is in: Nest/<username>_<id>/files/...
  // With `inside`, the path must be at or under the files folder, not above it.
  function nestOwner(segs, inside = false) {
    if (segs[0] !== 'Nest' || segs.length < 2 || (inside && (segs.length < 3 || segs[2] !== 'files'))) return null;
    return db().users.find((u) => `${u.username}_${u.id}` === segs[1]) || null;
  }
  nest.syncUsage();
  const glint = new Glint({ nest });
  glint.importer = new Importer({ glint, nest });
  nest.importer = new NestImporter({ glint, nest });
  const photoBackup = new PhotoBackup({ nest, dbFile: path.join(dataDir, 'photo-backup.db') });
  // The free Immich phone app backing up to Glint (see src/immich.js).
  const immich = new ImmichApi({
    photoBackup,
    log: (line) => console.log(`Immich app asked for something Roost does not answer: ${line}`),
    signIn: (req, name, secret) => {
      const ip = clientIp(req, trustProxy);
      if (!limiter.allow(ip)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      const username = str(name, 254).toLowerCase().split('@')[0];
      const user = db().users.find((u) => u.username === username);
      const key = typeof secret === 'string' && secret ? sessions.get(secret) : null;
      const keyOk = Boolean(user && key && key.userId === user.id && key.kind === 'app');
      const passOk = Boolean(user && !user.twoStep && typeof secret === 'string' && verifyPassword(secret, user.password));
      if (!keyOk && !passOk) {
        limiter.fail(ip);
        record(req, 'sign-in-failed', { target: username || null, detail: 'Immich app' });
        throw new HttpError(401, user && user.twoStep ? 'This account uses two-step sign-in. Use a backup key from Profile as the password.' : 'Wrong username or password');
      }
      if (guestEnded(user)) throw new HttpError(403, 'Your guest pass has ended. Ask whoever invited you for more time.');
      if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
      record(req, 'sign-in', { actor: user.username, detail: 'Immich app' });
      return { user, token: keyOk ? secret : sessions.create(user.id, { kind: 'app', name: 'Immich app' }) };
    },
    userFor: (req) => {
      // The app sends its token as a Bearer, as x-immich-user-token or as x-api-key, depending on its version.
      if (!req.headers.authorization) {
        const t = req.headers['x-immich-user-token'] || req.headers['x-api-key'];
        if (t) req.headers.authorization = `Bearer ${t}`;
      }
      const user = requireUser(req);
      if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
      return user;
    },
  });
  const search = createSearch({ sources: [nestSource(nest)], visibleApps: (user) => visibleApps(db(), user) });
  const sweep = () => nest.sweep().then(() => glint.sweep()).catch((err) => console.error('Nest clean-up failed:', err));
  sweep();
  const sweepTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
  sweepTimer.unref();
  // Browsers send the session cookie; phone apps send their device key as a
  // Bearer token.
  function tokenOf(req) {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    // If the browser sent two sign-in cookies (an old one for this exact
    // address next to a newer one for the whole domain), use the one that is
    // still a live sign-in rather than whichever came last.
    const all = cookieValues(req, COOKIE);
    return all.find((t) => sessions.get(t)) || all[all.length - 1];
  }

  // Jellyfin is checked where Roost itself reaches it (Admin → Jellyfin
  // sign-in), which is known to work, not at the app card's template address
  // (port 8096 unless edited), which goes stale when Jellyfin moves port.
  const probeApp = (a) => (a.id === 'jellyfin' && jellyfin.enabled() ? { ...a, url: db().settings.jellyfin.url } : a);
  // Jellyfin shows as Roostflix while Roost skins it.
  const shownName = (a) => (a.id === 'jellyfin' && jellyfin.enabled() && db().settings.roostflix !== false ? roostflix.NAME : a.name);

  // Uptime history: containers are re-read when Docker reports a change, and
  // apps without one get a web check every few minutes (see src/uptime.js).
  const uptime = new UptimeLog(dataDir);
  let lastDocker = { error: 'not checked' };
  async function checkUptime({ web, containers = true }) {
    // With Docker events coming through, the last container read is still current.
    if (containers || lastDocker.error) {
      lastDocker = dockerHost ? await listContainers(dockerHost, probeTimeoutMs) : { error: 'not configured' };
    }
    const docker = lastDocker;
    const tracked = [];
    await Promise.all(db().apps.map(async (a) => {
      const list = docker.error ? [] : containersFor(a, docker.containers);
      if (list.length) {
        tracked.push(a.id);
        uptime.observe(a.id, list.every((c) => c.state === 'running' && c.health !== 'unhealthy'));
        return;
      }
      // Nova is the galaxies' menu: it is up while every galaxy answers.
      if (a.id === 'nova' && novaHasGalaxies()) {
        tracked.push(a.id);
        if (web) uptime.observe(a.id, (await novaGalaxies()).every((g) => g.state === 'online'));
        return;
      }
      // Built-in apps are part of Roost; Roost's own row covers them.
      if (!a.url || builtIn(a.url)) return;
      tracked.push(a.id);
      if (!web) return;
      const target = probeApp(a).url;
      if (target.includes('{host}') && !uptime.host) return;
      const r = await timedProbe(target.replace(/\{host\}/g, uptime.host), probeTimeoutMs);
      uptime.observe(a.id, r.state === 'online');
    }));
    uptime.forget(tracked);
  }
  let uptimeBusy = false;
  let uptimeSoon = null;
  const runUptime = (opts) => {
    if (uptimeBusy) return;
    uptimeBusy = true;
    checkUptime(opts)
      .catch((err) => console.error('Uptime check failed:', err))
      .finally(() => { uptimeBusy = false; });
  };
  // A burst of Docker events (a restart is several) makes one check.
  const events = watchDockerEvents(dockerHost, () => {
    if (uptimeSoon) return;
    uptimeSoon = setTimeout(() => { uptimeSoon = null; runUptime({ web: false }); }, 2000);
    uptimeSoon.unref();
  });
  // Alerts watch the same container read the uptime log uses, so with Docker
  // events coming through they add no Docker calls of their own.
  // Phone alerts go out from Roost itself (src/push.js); nothing is polled.
  const push = new Push({
    store,
    isAdmin: (id) => (db().users.find((u) => u.id === id) || {}).role === 'admin',
    subject: () => (/^https:\/\//.test(db().settings.publicUrl || '') ? db().settings.publicUrl : undefined),
    ...pushOptions,
  });
  const cockerel = new Cockerel({ store, newId: () => store.newId(), fetchImpl: coffeeOptions.fetchImpl || fetch, seal: (t) => secrets.seal(dataDir, t), open: (b) => secrets.open(dataDir, b) });
  const assistant = new Assistant({ store, newId: () => store.newId() });
  // Cockerel hears what the admin's phone hears: movie requests and Sentinel alerts.
  const pushNotify = push.notify.bind(push);
  push.notify = (message, userId = null, opts) => {
    pushNotify(message, userId, opts);
    if (!userId) cockerel.event(message);
  };
  const secWatch = new SecurityWatch({ store, push, newId: () => store.newId() });
  const sentinel = new Sentinel({
    dataDir,
    store,
    raise: (key, title, detail) => secWatch.raise(key, title, detail),
    lockdown: (by) => engageLockdown(by),
    endSession: (userId, sessionId) => sessions.destroyId(userId, sessionId),
    // Docker's build steps for an update show up as unnamed containers.
    busy: () => {
      const helper = selfUpdate.readHelperStatus(dataDir);
      return selfUpdate.summarize(selfUpdate.readStatus(dataDir)).state === 'applying' || Boolean(helper && helper.state === 'building') || selfUpdate.hasRequest(dataDir);
    },
    // Never ban the home network, or Cloudflare's own addresses.
    skip: (ip) => isPrivateIp(ip) || remoteAccess.isCloudflare(ip),
  });
  // Power and heat history for the charts, fed by the watcher's minute check.
  const healthHistory = new HealthHistory(dataDir);
  const watcher = new Watcher({
    store,
    sample: (t) => {
      const drives = driveHealth.read();
      healthHistory.recordDrives(drives && drives.drives, t);
      const view = sensors.view({ driveHealth: drives, settings: db().settings });
      const live = view && !view.missing && !view.stale ? view : null;
      const checked = drives && !drives.missing && !drives.stale ? drives.drives : [];
      const hot = driveTrends.hottest(checked);
      healthHistory.sample({
        watts: live && live.power ? live.power.watts : null,
        cpuTemp: live ? live.cpuTemp : null,
        driveTemp: hot ? hot.details.temp : null,
        driveHeat: driveTrends.heatMargin(checked),
      }, t);
    },
    readTrends: (open, t) => driveTrends.trendProblems({ history: healthHistory, driveHealth: driveHealth.read(), now: t, open }),
    tidy: (t) => secWatch.tidy(t),
    onChange: (kind, alert) => push.alert(kind, alert),
    readContainers: async () => {
      const read = await (readContainers || (async () => (events.live() && !lastDocker.error ? lastDocker : listContainers(dockerHost, probeTimeoutMs))))();
      // Sentinel looks at the same reading, so it adds no Docker calls of its own.
      if (read && read.containers) sentinel.containers(read.containers);
      return read;
    },
    readDisks: () => readDisks(diskList),
    newId: () => store.newId(),
  });

  // Containers are only re-read on the timer when Docker events aren't coming through.
  const uptimeTimer = setInterval(() => {
    uptime.heartbeat();
    runUptime({ web: true, containers: !events.live() });
  }, uptimeCheckMs);
  uptimeTimer.unref();
  const uptimeSaveTimer = setInterval(() => uptime.save(), 60 * 60 * 1000);
  uptimeSaveTimer.unref();
  runUptime({ web: true });

  // Restarts an app's containers that the Docker helper lists. Turned away with
  // an HttpError when it can't (no Docker, not on the list, restarted less than
  // minGapMs ago); a restart Docker itself fails carries restartFailed.
  async function restartApp(app, minGapMs) {
    const docker = await listContainers(dockerHost, probeTimeoutMs);
    if (docker.error) throw new HttpError(503, 'Docker is not connected');
    const allowed = new Set(docker.restartable);
    const names = containersFor(app, docker.containers)
      .map((c) => c.name)
      .filter((n) => allowed.has(n) && n !== roostContainer);
    if (!names.length) throw new HttpError(403, `${app.name} can't be restarted from Roost`);
    if (Date.now() - (restartedAt.get(app.id) || 0) < minGapMs) throw new HttpError(429, `${app.name} was just restarted. Give it a moment.`);
    restartedAt.set(app.id, Date.now());
    try {
      await Promise.all(names.map((n) => restartContainer(dockerHost, n)));
    } catch (cause) {
      restartedAt.delete(app.id);
      throw Object.assign(new Error('restart failed'), { restartFailed: true, cause });
    }
    return names;
  }

  // Scheduled restarts. One cheap check every 20 seconds (no Docker call unless
  // an app is due); each schedule fires once in its minute, skips an app that
  // was restarted in the last 10 minutes, and a restart missed because Roost
  // was off is not made up later.
  const scheduledMinute = new Map();
  const runSchedules = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    for (const app of db().apps) {
      if (!isDue(app.restartSchedule, now) || scheduledMinute.get(app.id) === minute) continue;
      scheduledMinute.set(app.id, minute);
      restartApp(app, 10 * 60 * 1000).then(
        (names) => activity.add('app-restarted', { actor: 'schedule', detail: `${app.name} (${names.join(', ')})` }),
        (err) => {
          if (err.status === 429) return; // Someone just restarted it by hand.
          const why = err.restartFailed ? err.cause.message : err.message;
          activity.add('app-restart-failed', { actor: 'schedule', detail: `${app.name}: ${why}` });
        },
      );
    }
  };
  // Cockerel's notebook: reminders fire here, and a repeating job or the
  // morning brief wakes him only when its minute comes.
  const runCockerelJob = (prompt, label, { always = false } = {}) => {
    cockerel.call('POST', '/run', { prompt, mode: 'scheduled', context: assistant.context(), toolsOff: assistant.settings().toolsOff }, 5 * 60 * 1000).then((out) => {
      const text = str(out.reply, 4000);
      if (!text || (!always && /^nothing\b/i.test(text))) return;
      cockerel.add({ kind: 'cockerel', text });
      pushNotify({ title: label, body: text.slice(0, 140), tag: `cockerel-job-${Date.now()}`, url: '/#/cockerel' });
    }).catch((err) => cockerel.add({ kind: 'note', text: `${label} didn't run: ${err.message}` }));
  };
  async function briefFacts() {
    const a = assistant.data();
    const tz = assistant.tz();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(Date.now());
    const lines = [];
    const open = a.tasks.filter((t) => !t.done);
    lines.push(open.length ? `Open tasks: ${open.map((t) => `${t.text}${t.due ? ` (due ${t.due})` : ''}`).join('; ')}` : 'No open tasks.');
    const today = a.reminders.filter((r) => !r.done && new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(Date.parse(r.at)) === day);
    if (today.length) lines.push(`Reminders today: ${today.map((r) => r.text).join('; ')}`);
    try {
      if (jellyfin.enabled()) {
        const out = await jellyfin.call('GET', '/Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=DateCreated&SortOrder=Descending&Limit=6&Fields=DateCreated');
        const fresh = ((out && out.Items) || []).filter((i) => Date.now() - Date.parse(i.DateCreated) < 26 * 3600e3).map((i) => i.Name);
        if (fresh.length) lines.push(`New on Roostflix since yesterday: ${fresh.join(', ')}`);
      }
    } catch { /* Roostflix is optional */ }
    return lines.join('\n');
  }
  const assistantTick = () => {
    const now = new Date();
    for (const r of assistant.dueReminders()) {
      cockerel.add({ kind: 'cockerel', text: `Reminder: ${r.text}` });
      pushNotify({ title: 'Reminder', body: r.text, tag: `cockerel-r-${r.id}`, url: '/#/cockerel' });
    }
    if (!cockerel.enabled() || cockerel.config().paused) return;
    for (const j of assistant.dueJobs(now)) runCockerelJob(`Scheduled job. ${j.text}\n\nIf there is nothing worth telling Raven, reply with just the word NOTHING.`, 'Cockerel');
    if (assistant.briefDue(now)) {
      briefFacts().then((facts) => runCockerelJob(`Write Raven's morning brief, in short spoken sentences, under 120 words, no markdown. Facts from Roost:\n${facts}\nAlso run cockerel-tool events 15 for overnight alerts and mention anything that needs him. If your notes name where he lives, search the web for today's weather there. Say if anything needs a decision from him.`, 'Morning brief', { always: true }));
    }
  };
  const scheduleTimer = setInterval(() => { runSchedules(); assistantTick(); }, scheduleCheckMs);
  scheduleTimer.unref();

  function currentUser(req) {
    const s = sessions.get(tokenOf(req));
    const user = s ? db().users.find((u) => u.id === s.userId) || null : null;
    if (user && guestEnded(user)) {
      sessions.destroyUser(user.id);
      return null;
    }
    // An admin's browser cookie turning up in a different browser or device is a sign it was stolen.
    if (user && user.role === 'admin' && s.kind === 'browser' && s.name && req.socket.encrypted) {
      const now = deviceName(req.headers['user-agent']);
      if (now !== s.name && sentinel.sessionMismatch({ userId: user.id, username: user.username, sessionId: s.id, was: s.name, now, ip: clientIp(req, trustProxy) })) return null;
    }
    return user;
  }

  // Signed-in people who aren't guests: guests see their apps and nothing
  // about the server.
  function requireMember(req) {
    const user = requireUser(req);
    if (user.role === 'guest') throw new HttpError(403, 'Not available on a guest pass');
    return user;
  }

  // Signed in, and Birdhouse is one of their apps.
  function requireBirdhouse(req) {
    const user = requireUser(req);
    if (!visibleApps(db(), user).some((a) => a.id === 'birdhouse')) throw new HttpError(403, 'Birdhouse is not on for you');
    return user;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in first');
    return user;
  }

  function requireAdmin(req) {
    const user = requireUser(req);
    if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
    if (twoStepNeeded(db(), user)) throw new HttpError(403, 'Set up two-step sign-in first');
    return user;
  }

  function record(req, type, fields = {}) {
    activity.add(type, { ...fields, ip: clientIp(req, trustProxy) });
    secWatch.onActivity(type, fields);
    if (type === 'sign-in-failed') {
      if (req.socket.encrypted && !/^guest/.test(fields.detail || '')) sentinel.failedSignIn(clientIp(req, trustProxy), fields.target);
    } else if (type !== 'sign-in' && type !== 'sign-out') {
      sentinel.reseal(); // a change through a Roost screen, so not tampering
    }
  }

  const gbText = (limit) => (limit === null ? 'no limit' : `${limit} GB`);

  // Cookies are marked Secure whenever this request came over HTTPS.
  const secure = (req) => secureCookies || isSecure(req, trustProxy);

  // With the Coffee Galaxy gateway on, the sign-in cookie covers every name under
  // the domain, so signing in once works on nova.<domain> too (and signing out clears both).
  function cookieDomain(req) {
    const domain = coffee.enabled() || galaxyList().some((g) => g.enabled && g.secret) ? (db().settings.tls || {}).domain : '';
    const host = requestHost(req).toLowerCase();
    return domain && (host === domain || host.endsWith(`.${domain}`)) ? domain : '';
  }

  // A sign-in that names a device (an app on a phone) gets a long-lived device
  // key in the reply instead of a cookie.
  function login(req, res, user, { status = 200, cookies = [], device = '', password = null } = {}) {
    if (guestEnded(user)) throw new HttpError(403, 'Your guest pass has ended. Ask whoever invited you for more time.');
    if (secWatch.adminDevice(user, device || deviceName(req.headers['user-agent']), clientIp(req, trustProxy))) store.save();
    if (device) {
      const key = sessions.create(user.id, { kind: 'app', name: device });
      return send(res, status, { user: publicUser(db(), user), key });
    }
    const token = sessions.create(user.id, { name: deviceName(req.headers['user-agent']) });
    if (password !== null) linkJellyfin(sessions.get(token), user, password);
    send(res, status, { user: publicUser(db(), user) }, { 'Set-Cookie': [...sessionCookies(req, token), ...cookies] });
  }

  // The sign-in cookie for this address, plus an expiring copy of the other
  // kind (exact address vs. whole domain) so an old one can't shadow it.
  function sessionCookies(req, token) {
    const sec = secure(req);
    const domain = cookieDomain(req);
    const other = domain ? '' : knownDomain(req);
    return [sessionCookie(token, sec, domain), ...(domain || other ? [sessionCookie('', sec, domain ? '' : other)] : [])];
  }

  // The domain a Domain cookie would have used for this request, even if the
  // gateway that sets it is now off.
  function knownDomain(req) {
    const domain = (db().settings.tls || {}).domain;
    const host = requestHost(req).toLowerCase();
    return domain && (host === domain || host.endsWith(`.${domain}`)) ? domain : '';
  }

  // ---------- Jellyfin ----------

  const movieRequests = () => {
    if (!Array.isArray(db().movieRequests)) db().movieRequests = [];
    return db().movieRequests;
  };

  function canUseJellyfin(user) {
    return visibleApps(db(), user).some((a) => a.id === 'jellyfin');
  }

  function jellyfinFailed(err) {
    console.error(`Jellyfin: ${err.message}`);
  }

  // Roost only knows a password at the moment it's typed, so that's when the
  // Jellyfin account gets the same one.
  function syncJellyfinPassword(user, password) {
    if (!jellyfin.enabled() || !canUseJellyfin(user)) return Promise.resolve(null);
    return jellyfin.ensureAccount(user.username, password, user.role).catch((err) => { jellyfinFailed(err); return null; });
  }

  // Signs this browser in to Jellyfin as well, in the background. The token is
  // kept with the Roost sign-in and ends with it.
  function linkJellyfin(session, user, password) {
    if (!session || !jellyfin.enabled() || !canUseJellyfin(user)) return;
    const work = syncJellyfinPassword(user, password)
      .then(() => jellyfin.signIn(user.username, password, { device: session.name || 'Roost', deviceId: `roost-${session.id}` }))
      .then((jf) => {
        if (sessions.list(user.id).includes(session)) {
          session.jf = jf;
          sessions.save();
        } else {
          jellyfin.logout(jf.token).catch(() => {});
        }
      })
      .catch(jellyfinFailed)
      .finally(() => jellyfinLinks.delete(session.id));
    jellyfinLinks.set(session.id, work);
  }

  // Who should have a Jellyfin account: people who may open it, and whose
  // guest pass hasn't ended.
  function jellyfinPeople() {
    return db().users.filter((u) => canUseJellyfin(u) && !guestEnded(u)).map((u) => ({ username: u.username, role: u.role }));
  }

  function jellyfinAccessChanged(user, roleChanged = false) {
    if (!jellyfin.enabled()) return;
    if (canUseJellyfin(user)) {
      jellyfin.enable(user.username).catch(jellyfinFailed);
      if (roleChanged) jellyfin.roleChanged(user.username, user.role).catch(jellyfinFailed);
      return;
    }
    for (const s of sessions.list(user.id)) {
      if (s.jf) jellyfin.logout(s.jf.token).catch(() => {});
      delete s.jf;
    }
    sessions.save();
    jellyfin.disable(user.username).catch(jellyfinFailed);
  }

  function deviceView(s, current) {
    return { id: s.id, kind: s.kind, name: s.name, created: new Date(s.created).toISOString(), lastSeen: new Date(s.lastSeen).toISOString(), current };
  }

  function forget(map) {
    const now = Date.now();
    for (const [k, v] of map) if (v.expires < now) map.delete(k);
  }

  function isTrusted(req, user) {
    const token = parseCookies(req)[TRUST_COOKIE];
    if (!token || !Array.isArray(user.trusted)) return false;
    const hash = sha256(token);
    return user.trusted.some((t) => t.hash === hash && t.expires > Date.now());
  }

  function trustDevice(req, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    user.trusted = (user.trusted || []).filter((t) => t.expires > now).slice(-(MAX_TRUSTED - 1));
    user.trusted.push({ hash: sha256(token), expires: now + TRUST_TTL_MS });
    return trustCookie(token, secure(req));
  }

  function checkPassword(user, password) {
    if (typeof password !== 'string' || !verifyPassword(password, user.password)) throw new HttpError(400, 'Password is wrong');
  }

  function twoStepStatus(user) {
    const now = Date.now();
    return {
      on: Boolean(user.twoStep),
      required: user.role === 'admin' && adminsNeedTwoStep(db()),
      recoveryLeft: user.twoStep ? user.twoStep.recovery.length : 0,
      trustedDevices: (user.trusted || []).filter((t) => t.expires > now).length,
      since: user.twoStep ? user.twoStep.enabledAt : null,
    };
  }

  async function jellyfinView() {
    const c = db().settings.jellyfin;
    const skin = db().settings.roostflix !== false;
    if (!c || !c.url) return { url: '', keySaved: false, connected: false, skin };
    try {
      const info = await jellyfin.check();
      const have = new Set((await jellyfin.users()).map((u) => u.Name.toLowerCase()));
      const missing = jellyfinPeople().filter((p) => !have.has(p.username.toLowerCase())).length;
      return { url: c.url, keySaved: Boolean(c.apiKey), connected: true, skin, ...info, missing };
    } catch (err) {
      return { url: c.url, keySaved: Boolean(c.apiKey), connected: false, skin, error: err.status === 401 ? 'the API key was refused' : err.message };
    }
  }

  function cleanApps(input) {
    if (!Array.isArray(input) || input.length > 48) throw new HttpError(400, 'Apps must be a list');
    const seen = new Set();
    return input.map((a) => {
      const app = {
        id: str(a.id, 40) || store.newId(),
        name: str(a.name, 40),
        tagline: str(a.tagline, 40),
        description: str(a.description, 200),
        url: str(a.url, 500),
        container: str(a.container, 200),
        icon: ICONS.includes(a.icon) ? a.icon : 'grid',
      };
      const schedule = cleanSchedule(a.restartSchedule);
      if (schedule instanceof Error) throw new HttpError(400, `${app.name || 'App'}: ${schedule.message}`);
      if (schedule) app.restartSchedule = schedule;
      if ((db().apps.find((x) => x.id === app.id) || {}).adminOnly) app.adminOnly = true; // saving the list keeps it
      // The Nova card's link to the Galaxies page is added when apps are listed, not saved.
      if (app.id === 'nova' && app.url === '#/galaxies') app.url = '';
      if (!app.name) throw new HttpError(400, 'Every app needs a name');
      if (!/^[a-z0-9-]+$/i.test(app.id) || seen.has(app.id)) throw new HttpError(400, 'Bad app id');
      if (!validAppUrl(app.url)) throw new HttpError(400, `${app.name}: link must start with http:// or https://`);
      seen.add(app.id);
      return app;
    });
  }

  // ?space=family works in the family space instead of the person's own files.
  function spaceOwner(user, params) {
    if (params.get('space') !== 'family') return user;
    if (!family.isMember(db(), user)) throw new HttpError(403, 'You’re not in the family space');
    return family.familyOf(db());
  }

  function familyView() {
    const fam = family.familyOf(db());
    const s = storage.storageOf(db(), fam);
    return { members: fam.members, limitGb: s.limitGb, usedBytes: s.usedBytes };
  }

  // When a guest pass ends: a date or time after now, up to a year ahead.
  function cleanGuestUntil(v) {
    const t = Date.parse(v);
    if (!(t > Date.now() && t <= Date.now() + GUEST_MAX_MS)) throw new HttpError(400, 'Pick when the guest pass ends, up to a year from now');
    return new Date(t).toISOString();
  }

  function cleanLimit(v) {
    const limit = storage.parseLimitGb(v);
    if (limit === undefined) throw new HttpError(400, `Storage limit must be a whole number of GB from 1 to ${storage.MAX_LIMIT_GB}, or blank for no limit`);
    return limit;
  }

  // The address invite and reset links use, e.g. https://roostos.network.
  // Blank means "whatever address the admin has Roost open on".
  function cleanPublicUrl(v) {
    const raw = str(v, 200);
    if (!raw) return '';
    if (raw.includes('://') && !/^https?:\/\//i.test(raw)) throw new HttpError(400, 'Public address must start with http:// or https://');
    let url;
    try {
      url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    } catch {
      throw new HttpError(400, 'Public address must look like https://roostos.network');
    }
    return url.origin;
  }

  // Birdhouse's Claude key: kept encrypted (see secrets.js); only the last four
  // characters and the spending so far are ever shown.
  const aiDefaults = { monthCap: 5, dayCap: 20 };
  function aiState() {
    const a = db().settings.birdhouseAi || {};
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const u = a.usage || {};
    return {
      on: Boolean(a.key),
      last4: a.last4 || '',
      monthCap: a.monthCap ?? aiDefaults.monthCap,
      dayCap: a.dayCap ?? aiDefaults.dayCap,
      today: u.day === day ? u.count : 0,
      spent: u.month === month ? u.spent : 0,
    };
  }
  function aiView() {
    return aiState();
  }
  function aiUse(usd) {
    const a = db().settings.birdhouseAi;
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const u = a.usage && a.usage.month === month ? a.usage : { month, spent: 0, day, count: 0 };
    if (u.day !== day) { u.day = day; u.count = 0; }
    u.count += 1;
    u.spent = Math.round((u.spent + usd) * 10000) / 10000;
    a.usage = u;
    store.save();
  }

  // Settings for the admin page. The mail password never leaves the server.
  function settingsView() {
    // The Cloudflare token (in tls) stays on the server.
    const { mail: _mail, jellyfin: _jellyfin, tls: _tls, coffee: _coffee, wireguard: _wireguard, galaxies: _galaxies, birdhouseAi: _birdhouseAi, cockerel: _cockerel, ...rest } = db().settings;
    return { ...rest, backup: backup.config(rest.backup), publicUrl: rest.publicUrl || '', defaultLimitGb: storage.defaultLimitGb(db()), mail: mailView(), mailEnabled: mailReady(), adminsNeedTwoStep: adminsNeedTwoStep(db()), publicLinks: rest.publicLinks !== false, birdhouseFetch: rest.birdhouseFetch === true, birdhouseAi: aiView(), ...energyView() };
  }

  // The admin's notice on the dashboard. Expired notices are simply not
  // returned, so nothing has to run to take one down.
  function activeNotice() {
    const n = db().settings.notice;
    if (!n || (n.until && Date.parse(n.until) <= Date.now())) return null;
    return n;
  }

  function cleanUntil(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const t = Date.parse(raw);
    if (Number.isNaN(t) || t <= Date.now()) throw new HttpError(400, 'The end time must be in the future');
    if (t > Date.now() + 366 * 86400 * 1000) throw new HttpError(400, 'The end time must be within a year');
    return new Date(t).toISOString();
  }

  function adminView(user) {
    return { ...publicUser(db(), user), storage: storage.storageOf(db(), user) };
  }

  function requireApp(req) {
    if (!storage.appTokenOk(req, appToken)) throw new HttpError(401, 'App token missing or wrong');
  }

  function certSummary() {
    const s = certs.status();
    if (s.state === 'off') return null;
    return { state: s.state, domain: s.domain, daysLeft: s.certificate ? s.certificate.daysLeft : null, expiresAt: s.certificate ? s.certificate.expiresAt : null, error: s.lastError };
  }

  // What the admin page shows, plus how this browser reached Roost.
  function tlsView(req) {
    return {
      ...certs.status(),
      connection: { secure: isSecure(req, trustProxy), viaCloudflare: !!req.headers['cf-connecting-ip'], host: requestHost(req) },
    };
  }

  function helperSummary() {
    const updater = selfUpdate.summarize(selfUpdate.readStatus(dataDir));
    return selfUpdate.summarizeHelper(selfUpdate.readHelperStatus(dataDir), updater.state, selfUpdate.hasRequest(dataDir));
  }

  // The electricity price for the power cost, per kWh in pence (or cents).
  function energyView() {
    const { price, currency } = priceOf(db().settings);
    return { energyPrice: price, energyCurrency: currency };
  }

  function cleanDiskPct(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 50 || n > 99) throw new HttpError(400, 'Drive alert level must be a whole number from 50 to 99');
    return n;
  }

  const pushDeviceView = (d) => ({ id: d.id, label: d.label, createdAt: d.createdAt });

  function alertView() {
    const alerts = alertsOf(db());
    return {
      active: alerts.filter((a) => !a.resolvedAt).reverse(),
      recent: alerts.filter((a) => a.resolvedAt).reverse().slice(0, 20),
      checkedAt: watcher.checkedAt,
      settings: alertSettings(db()),
    };
  }

  function cleanAppAccess(apps) {
    if (apps === null || apps === undefined) return null;
    if (!Array.isArray(apps)) throw new HttpError(400, 'Apps must be a list');
    const ids = new Set(db().apps.map((a) => a.id));
    return apps.filter((id) => ids.has(id));
  }

  // ---------- email ----------

  function mailSettings() {
    return db().settings.mail || null;
  }

  // Emails need the public address so their links open from anywhere; the
  // address in a request can't be trusted for that.
  function mailReady() {
    const m = mailSettings();
    return Boolean(m && m.host && m.from && db().settings.publicUrl);
  }

  function mailView() {
    const m = mailSettings();
    if (!m) return { host: '', port: 587, security: 'starttls', user: '', from: '', hasPassword: false };
    const { password, ...rest } = m;
    return { ...rest, hasPassword: Boolean(password) };
  }

  function cleanMail(input, current) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Email settings must be an object');
    const host = str(input.host, 200);
    if (!host) return null; // Blank host turns email off.
    if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new HttpError(400, 'Mail server must be a host name like smtp.resend.com');
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be a number like 587 or 465');
    const security = mail.SECURITY.includes(input.security) ? input.security : 'starttls';
    const from = str(input.from, 254);
    if (!mail.validEmail(from)) throw new HttpError(400, 'Send from must be an email address like server@roostos.network');
    const password = typeof input.password === 'string' && input.password !== ''
      ? input.password.slice(0, 500)
      : (current && current.password) || '';
    const next = { host, port, security, user: str(input.user, 254), password, from };
    // A passed test only counts for the settings it was sent with.
    const same = current && ['host', 'port', 'security', 'user', 'password', 'from'].every((k) => current[k] === next[k]);
    if (same && current.verifiedAt) next.verifiedAt = current.verifiedAt;
    return next;
  }

  function cleanEmail(v) {
    const email = str(v, 254).toLowerCase();
    if (email && !mail.validEmail(email)) throw new HttpError(400, "That doesn't look like an email address");
    if (email && db().users.some((u) => u.email === email)) throw new HttpError(409, 'Another account already uses that email');
    return email;
  }

  function linkUrl(kind, token) {
    return `${db().settings.publicUrl}/${kind === 'reset' ? 'r' : 'j'}/${token}`;
  }

  // `html` is the styled version; the plain text always goes with it.
  async function deliver(to, subject, text, html) {
    const m = mailSettings();
    const inline = html ? { cid: emailTemplate.HEADER_CID, type: 'image/gif', data: emailTemplate.HEADER } : undefined;
    await sendMail(m, { from: m.from, fromName: db().settings.serverName, to, subject, text, html, inline });
  }

  function resetEmail(user, token, validFor) {
    const name = db().settings.serverName;
    return [`Reset your ${name} password`, [
      `Hi ${user.displayName},`,
      '',
      `Someone (hopefully you) asked to reset the password for @${user.username} on ${name}.`,
      '',
      'Choose a new password here:',
      linkUrl('reset', token),
      '',
      `The link works once, for ${validFor}. If you didn't ask for this, ignore this email: your password hasn't changed.`,
    ].join('\n'), emailTemplate.render({
      title: `Reset your ${name} password`,
      paragraphs: [`Hi ${user.displayName},`, `Someone (hopefully you) asked to reset the password for @${user.username} on ${name}.`],
      button: { label: 'Choose a new password', url: linkUrl('reset', token) },
      fine: `The link works once, for ${validFor}. If you didn't ask for this, ignore this email: your password hasn't changed.`,
    })];
  }

  function inviteEmail(admin, token) {
    const name = db().settings.serverName;
    return [`You're invited to ${name}`, [
      `${admin.displayName} has invited you to ${name}.`,
      '',
      'Open this link to choose your username and password:',
      linkUrl('join', token),
      '',
      'The link works once and stops working after 7 days.',
    ].join('\n'), emailTemplate.render({
      title: `You're invited to ${name}`,
      paragraphs: [`${admin.displayName} has invited you to ${name}. Choose your username and password and you're in.`],
      button: { label: `Join ${name}`, url: linkUrl('join', token) },
      fine: 'The link works once and stops working after 7 days.',
      signoff: 'Welcome to the Roost',
    })];
  }

  // Only the newest reset link for a user works.
  function newResetLink(user, createdBy, ttlMs) {
    db().links = (db().links || []).filter((l) => !(l.kind === 'reset' && l.userId === user.id));
    return links.create(db(), { id: store.newId(), kind: 'reset', userId: user.id, createdBy }, ttlMs);
  }

  const forgotSentAt = new Map();

  // Finds a live link or explains why it doesn't work. Only misses count
  // towards the rate limit, so typing a username doesn't lock anyone out.
  function openLink(req, token) {
    const link = links.find(db(), token);
    if (!link) {
      const key = `link:${clientIp(req, trustProxy)}`;
      if (!limiter.allow(key)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      limiter.fail(key);
      throw new HttpError(404, 'This link has expired or was already used');
    }
    if (link.kind === 'reset' && !db().users.some((u) => u.id === link.userId)) {
      throw new HttpError(404, 'This link has expired or was already used');
    }
    return link;
  }

  function usernameCheck(username) {
    if (!validUsername(username)) return { available: false, reason: '2–32 of a–z, 0–9, . _ -' };
    if (db().users.some((u) => u.username === username)) return { available: false, taken: true, reason: 'That username is taken' };
    return { available: true };
  }

  const routes = {
    // A tiny answer the app uses to check the server is back after losing it.
    'GET /api/ping': (req, res) => {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    },
    'GET /api/state': (req, res) => {
      const user = currentUser(req);
      send(res, 200, {
        serverName: db().settings.serverName,
        setupRequired: db().users.length === 0,
        mailEnabled: mailReady(),
        version: APP_VERSION,
        user: user ? publicUser(db(), user) : null,
      });
    },

    'POST /api/setup': async (req, res) => {
      if (db().users.length > 0) throw new HttpError(409, 'Roost is already set up');
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      if (!validUsername(username)) throw new HttpError(400, 'Username: 2–32 of a–z, 0–9, . _ -');
      if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
      const user = {
        id: store.newId(),
        username,
        displayName: str(body.displayName, 60) || username,
        role: 'admin',
        apps: null,
        limitGb: null,
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
      store.save();
      record(req, 'setup', { actor: user.username });
      login(req, res, user, { status: 201, password: body.password });
    },

    'POST /api/login': async (req, res) => {
      if (!limiter.allow(clientIp(req, trustProxy))) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      if (!guard.allow(username, clientIp(req, trustProxy), Boolean(req.socket.encrypted))) throw new HttpError(429, 'Too many wrong passwords for this account. Wait a few minutes, or sign in from home.');
      const user = db().users.find((u) => u.username === username);
      if (!user) verifyAgainstNobody(body.password);
      if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password)) {
        limiter.fail(clientIp(req, trustProxy));
        guard.fail(username);
        // Only the username typed is kept, never the password.
        record(req, 'sign-in-failed', { target: username || null, detail: user ? 'wrong password' : 'no such user' });
        throw new HttpError(401, 'Wrong username or password');
      }
      const device = str(body.device, 60);
      if (guestEnded(user)) record(req, 'sign-in-failed', { target: user.username, detail: 'guest pass ended' });
      if (!user.twoStep || isTrusted(req, user)) {
        guard.clear(username);
        record(req, 'sign-in', { actor: user.username, detail: user.twoStep ? 'trusted device' : '' });
        return login(req, res, user, { device, password: body.password });
      }
      forget(pendingCodes);
      const ticket = crypto.randomBytes(24).toString('hex');
      // The password is only held in memory until the code arrives, so the
      // Jellyfin sign-in can happen then too.
      pendingCodes.set(ticket, { userId: user.id, device, password: body.password, expires: Date.now() + CODE_WAIT_MS, tries: 0 });
      send(res, 200, { twoStep: true, ticket });
    },

    // Second step: a code from the authenticator app, or a recovery code.
    'POST /api/login/code': async (req, res) => {
      if (!limiter.allow(clientIp(req, trustProxy))) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      const body = await readJson(req);
      const pending = typeof body.ticket === 'string' && pendingCodes.get(body.ticket);
      if (!pending || pending.expires < Date.now()) throw new HttpError(401, 'That took too long. Sign in again.');
      const user = db().users.find((u) => u.id === pending.userId);
      if (!user || !user.twoStep) {
        pendingCodes.delete(body.ticket);
        throw new HttpError(401, 'Sign in again');
      }
      if (!guard.allow(user.username, clientIp(req, trustProxy), Boolean(req.socket.encrypted))) throw new HttpError(429, 'Too many wrong codes for this account. Wait a few minutes, or sign in from home.');
      const code = str(body.code, 40);
      let ok = false;
      if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
        const step = twoStep.verifyCode(user.twoStep.secret, code, user.twoStep.lastStep);
        if (step !== null) {
          user.twoStep.lastStep = step;
          ok = true;
        }
      } else {
        ok = twoStep.useRecoveryCode(user.twoStep, code);
      }
      if (!ok) {
        limiter.fail(clientIp(req, trustProxy));
        guard.fail(user.username);
        record(req, 'sign-in-failed', { target: user.username, detail: 'wrong two-step code' });
        pending.tries++;
        if (pending.tries >= CODE_TRIES) {
          pendingCodes.delete(body.ticket);
          throw new HttpError(401, 'Too many wrong codes. Sign in again.');
        }
        throw new HttpError(400, "That code didn't work. Check your app's newest code.");
      }
      pendingCodes.delete(body.ticket);
      guard.clear(user.username);
      record(req, 'sign-in', { actor: user.username, detail: /^\d/.test(code) ? 'with code' : 'with recovery code' });
      const cookies = body.trust === true && !pending.device ? [trustDevice(req, user)] : [];
      store.save();
      login(req, res, user, { cookies, device: pending.device, password: pending.password });
    },

    'POST /api/logout': (req, res) => {
      const user = currentUser(req);
      if (user) record(req, 'sign-out', { actor: user.username });
      sessions.destroy(tokenOf(req));
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookies(req, '') });
    },

    'PATCH /api/me': async (req, res) => {
      const user = requireUser(req);
      const body = await readJson(req);
      if (body.displayName !== undefined) user.displayName = str(body.displayName, 60) || user.username;
      if (body.email !== undefined) {
        const email = str(body.email, 254).toLowerCase();
        if (email !== (user.email || '')) user.email = cleanEmail(email);
      }
      if (body.appOrder !== undefined) user.appOrder = appIds(db(), body.appOrder);
      if (body.favourites !== undefined) user.favourites = appIds(db(), body.favourites);
      if (body.newPassword !== undefined) {
        if (typeof body.currentPassword !== 'string' || !verifyPassword(body.currentPassword, user.password)) {
          throw new HttpError(400, 'Current password is wrong');
        }
        if (!validPassword(body.newPassword)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.newPassword);
        // Anyone who knew the old password is signed out; this device stays in.
        sessions.destroyUser(user.id, tokenOf(req));
        syncJellyfinPassword(user, body.newPassword);
        record(req, 'password-changed', { actor: user.username, target: user.username });
      }
      store.save();
      send(res, 200, { user: publicUser(db(), user) });
    },

    // ---------- two-step sign-in ----------

    'GET /api/me/two-step': (req, res) => {
      send(res, 200, twoStepStatus(requireUser(req)));
    },

    // Makes a new authenticator secret; it only takes effect once a code from
    // it is confirmed.
    'POST /api/me/two-step/start': (req, res) => {
      const user = requireUser(req);
      if (user.twoStep) throw new HttpError(409, 'Two-step sign-in is already on');
      forget(pendingSetups);
      const secret = twoStep.newSecret();
      pendingSetups.set(user.id, { secret, expires: Date.now() + 15 * 60 * 1000 });
      const uri = twoStep.otpauthUri(secret, user.username, db().settings.serverName);
      send(res, 200, { secret, uri, qr: qrSvg(uri) });
    },

    'POST /api/me/two-step/enable': async (req, res) => {
      const user = requireUser(req);
      if (user.twoStep) throw new HttpError(409, 'Two-step sign-in is already on');
      const pending = pendingSetups.get(user.id);
      if (!pending || pending.expires < Date.now()) throw new HttpError(400, 'Setup timed out. Start again.');
      const body = await readJson(req);
      const step = twoStep.verifyCode(pending.secret, str(body.code, 20));
      if (step === null) throw new HttpError(400, "That code didn't work. Try the newest one in your app.");
      pendingSetups.delete(user.id);
      const recoveryCodes = twoStep.newRecoveryCodes();
      user.twoStep = {
        secret: pending.secret,
        lastStep: step,
        recovery: recoveryCodes.map(twoStep.hashCode),
        enabledAt: new Date().toISOString(),
      };
      user.trusted = [];
      store.save();
      record(req, 'two-step-on', { actor: user.username, target: user.username });
      send(res, 200, { user: publicUser(db(), user), recoveryCodes });
    },

    'POST /api/me/two-step/recovery-codes': async (req, res) => {
      const user = requireUser(req);
      if (!user.twoStep) throw new HttpError(400, 'Two-step sign-in is off');
      checkPassword(user, (await readJson(req)).password);
      const recoveryCodes = twoStep.newRecoveryCodes();
      user.twoStep.recovery = recoveryCodes.map(twoStep.hashCode);
      store.save();
      send(res, 200, { user: publicUser(db(), user), recoveryCodes });
    },

    'POST /api/me/two-step/disable': async (req, res) => {
      const user = requireUser(req);
      checkPassword(user, (await readJson(req)).password);
      delete user.twoStep;
      user.trusted = [];
      store.save();
      record(req, 'two-step-off', { actor: user.username, target: user.username });
      send(res, 200, { user: publicUser(db(), user) }, { 'Set-Cookie': trustCookie('', secure(req)) });
    },

    'POST /api/me/two-step/forget-devices': (req, res) => {
      const user = requireUser(req);
      user.trusted = [];
      store.save();
      send(res, 200, twoStepStatus(user), { 'Set-Cookie': trustCookie('', secure(req)) });
    },

    // "Not now" on the offer after sign-in; it stays available in Profile.
    'POST /api/me/two-step/skip': (req, res) => {
      const user = requireUser(req);
      user.twoStepSkipped = true;
      store.save();
      send(res, 200, { user: publicUser(db(), user) });
    },

    // ---------- signed-in devices ----------

    'GET /api/me/devices': (req, res) => {
      const user = requireUser(req);
      const current = sessions.get(tokenOf(req));
      send(res, 200, { devices: sessions.list(user.id).map((s) => deviceView(s, s === current)) });
    },

    'DELETE /api/me/devices/:id': (req, res, id) => {
      const user = requireUser(req);
      if (!sessions.destroyId(user.id, id)) throw new HttpError(404, 'That device is already signed out');
      send(res, 200, { ok: true });
    },

    // A key for something that can't type a password (an iPhone Shortcut), shown once.
    'POST /api/me/backup-key': async (req, res) => {
      const user = requireMember(req);
      if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
      const body = await readJson(req);
      const name = str(body.name, 40) || 'iPhone';
      send(res, 201, { key: sessions.create(user.id, { kind: 'app', name: `${name} backup` }) });
    },

    'POST /api/me/devices/sign-out-others': (req, res) => {
      const user = requireUser(req);
      sessions.destroyUser(user.id, tokenOf(req));
      send(res, 200, { ok: true });
    },

    // One sign-in for the apps Roost serves: Nest, Glint and anything behind a
    // proxy ask here who is signed in and whether they may use the app.
    'GET /api/auth/check': (req, res) => {
      const user = requireUser(req);
      const app = new URL(req.url, 'http://roost').searchParams.get('app');
      if (app && !visibleApps(db(), user).some((a) => a.id === app)) throw new HttpError(403, "You don't have access to this app");
      if (twoStepNeeded(db(), user)) throw new HttpError(403, 'Set up two-step sign-in first');
      send(res, 200, { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
    },

    'GET /api/apps': (req, res) => {
      const user = requireUser(req);
      // With the Jellyfin link on, the card opens Jellyfin through Roost,
      // already signed in.
      const apps = appsFor(user).map((a) => (a.id === 'jellyfin' && jellyfin.enabled() ? { ...a, openUrl: `${JELLYFIN_PREFIX}/`, ...(db().settings.roostflix === false ? {} : { name: roostflix.NAME }) } : galaxyOpenUrl(a, user)));
      send(res, 200, { apps, searchable: search.apps(user) });
    },

    // Birdhouse: whether Fetch price is switched on, and the fetch itself. It
    // reads one shop page, only when asked, and only for people with the app.
    'GET /api/birdhouse': (req, res) => {
      const user = requireUser(req);
      const has = visibleApps(db(), user).some((a) => a.id === 'birdhouse');
      const ai = aiState();
      send(res, 200, {
        fetch: db().settings.birdhouseFetch === true && has,
        ai: has && ai.on ? { tiers: birdhouseAi.TIER_IDS.map((id) => ({ id, label: birdhouseAi.TIERS[id].label, hint: birdhouseAi.TIERS[id].hint, estimate: Math.round(birdhouseAi.estimate(id) * 100) / 100 })), left: Math.max(0, ai.dayCap - ai.today), spent: ai.spent, monthCap: ai.monthCap } : null,
      });
    },
    'POST /api/birdhouse/price': async (req, res) => {
      const user = requireUser(req);
      if (db().settings.birdhouseFetch !== true || !visibleApps(db(), user).some((a) => a.id === 'birdhouse')) throw new HttpError(403, 'Fetching prices is switched off');
      if (Date.now() - (priceAsked.get(user.id) || 0) < 2000) throw new HttpError(429, 'One at a time, give it a moment');
      priceAsked.set(user.id, Date.now());
      const body = await readJson(req, 2048);
      try {
        send(res, 200, await birdhouse.fetchPrice(str(body.url, 500)));
      } catch (err) {
        if (err instanceof birdhouse.FetchError) throw new HttpError(422, err.message);
        throw err;
      }
    },

    // Birdhouse: "Design with Claude" through the API, only if an admin saved a key.
    'POST /api/birdhouse/design': async (req, res) => {
      const user = requireBirdhouse(req);
      const a = db().settings.birdhouseAi;
      if (!a || !a.key) throw new HttpError(403, 'Design with Claude is not set up');
      const body = await readJson(req, 60000);
      const tier = str(body.tier, 20);
      if (!birdhouseAi.TIER_IDS.includes(tier)) throw new HttpError(400, 'Pick a tier');
      const wish = str(body.prompt, 1500).trim();
      if (!wish) throw new HttpError(400, 'Say what you want to build');
      const st = aiState();
      if (st.today >= st.dayCap) throw new HttpError(429, `That is ${st.dayCap} designs today; try tomorrow or raise the limit in Admin`);
      if (st.spent + birdhouseAi.estimate(tier) > st.monthCap) throw new HttpError(429, `That could pass this month's $${st.monthCap} limit (spent $${st.spent.toFixed(2)}). Raise it in Admin or pick a cheaper tier`);
      if (designing) throw new HttpError(429, 'A design is already being made, give it a moment');
      const key = secrets.open(dataDir, a.key);
      if (!key) throw new HttpError(500, 'The saved key cannot be read. Save it again in Admin');
      designing = true;
      try {
        // Changing an existing design: it goes along, cleaned, so Claude builds on it.
        const cur = body.current && body.current.d ? birdhouseModel.clean(body.current.d) : null;
        const messages = [{ role: 'user', content: cur ? birdhouseModel.reviseRequest(cur, str(body.current.name, 60) || birdhouseModel.info(cur).name, wish) : wish }];
        let reply = await birdhouseAi.ask({ key, tier, system: birdhouseModel.designInstructions(), messages, baseUrl: aiBase });
        let spent = reply.cost;
        let read = birdhouseModel.readDesign(reply.text);
        if (!read.ok) {
          // One repair attempt, telling it what was wrong.
          messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: `That could not be used: ${read.error}. Reply again with only the JSON object in a code block.` });
          reply = await birdhouseAi.ask({ key, tier, system: birdhouseModel.designInstructions(), messages, baseUrl: aiBase });
          spent += reply.cost;
          read = birdhouseModel.readDesign(reply.text);
        }
        aiUse(spent);
        record(req, 'settings-changed', { actor: user.username, detail: `Birdhouse design (${tier}, about $${spent.toFixed(2)})` });
        if (!read.ok) throw new HttpError(422, `Claude's design could not be read (${read.error}). Try again`);
        send(res, 200, { d: read.d, name: read.name, notes: read.notes, problems: read.problems, cost: Math.round(spent * 1000) / 1000 });
      } catch (err) {
        if (err instanceof birdhouseAi.AiError) throw new HttpError(err.status, err.message);
        throw err;
      } finally {
        designing = false;
      }
    },
    // Admin: save or remove the key, and set the spending limits.
    'PUT /api/admin/birdhouse-ai': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req, 2000);
      const a = db().settings.birdhouseAi || (db().settings.birdhouseAi = {});
      const changes = [];
      if (body.remove === true && a.key) {
        delete a.key;
        delete a.last4;
        changes.push('Claude key removed');
      } else if (typeof body.key === 'string' && body.key.trim()) {
        const key = body.key.trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) throw new HttpError(400, 'That does not look like an Anthropic key (it starts sk-ant-)');
        a.key = secrets.seal(dataDir, key);
        a.last4 = key.slice(-4);
        changes.push('Claude key saved');
      }
      const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null);
      if (body.monthCap !== undefined) {
        const n = num(body.monthCap, 1, 1000);
        if (n === null) throw new HttpError(400, 'Monthly limit must be between $1 and $1000');
        a.monthCap = n;
        changes.push('monthly limit');
      }
      if (body.dayCap !== undefined) {
        const n = num(body.dayCap, 1, 500);
        if (n === null) throw new HttpError(400, 'Daily designs must be between 1 and 500');
        a.dayCap = Math.round(n);
        changes.push('daily limit');
      }
      store.save();
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: `Birdhouse Claude: ${changes.join(', ')}` });
      send(res, 200, aiView());
    },

    // Birdhouse: each person's plans, workshop wood and price book, kept on
    // their own Roost account so they follow them to any device.
    'GET /api/birdhouse/data': (req, res) => {
      const user = requireBirdhouse(req);
      send(res, 200, birdhouse.mine(user));
    },
    'POST /api/birdhouse/plans': async (req, res) => {
      const user = requireBirdhouse(req);
      const body = await readJson(req, 20000);
      const mineNow = birdhouse.mine(user);
      const old = mineNow.plans.find((p) => p.id === body.id);
      if (!old && mineNow.plans.length >= birdhouse.MAX_PLANS) throw new HttpError(400, `That is ${birdhouse.MAX_PLANS} plans; delete one first`);
      const plan = birdhouse.cleanPlan(body, old ? old.id : store.newId(), new Date().toISOString());
      if (old) Object.assign(old, plan); else mineNow.plans.push(plan);
      store.save();
      send(res, 200, plan);
    },
    'DELETE /api/birdhouse/plans/:id': (req, res, id) => {
      const user = requireBirdhouse(req);
      const mineNow = birdhouse.mine(user);
      const at = mineNow.plans.findIndex((p) => p.id === id);
      if (at < 0) throw new HttpError(404, 'That plan is already gone');
      mineNow.plans.splice(at, 1);
      store.save();
      send(res, 200, { ok: true });
    },
    'PUT /api/birdhouse/stock': async (req, res) => {
      const user = requireBirdhouse(req);
      const body = await readJson(req, 60000);
      birdhouse.mine(user).stock = birdhouse.cleanStock(body.stock, () => store.newId());
      store.save();
      send(res, 200, { stock: user.birdhouse.stock });
    },
    'PUT /api/birdhouse/prefs': async (req, res) => {
      const user = requireBirdhouse(req);
      const body = await readJson(req, 2000);
      birdhouse.mine(user).prefs = birdhouse.cleanPrefs(body);
      store.save();
      send(res, 200, user.birdhouse.prefs);
    },
    'PUT /api/birdhouse/prices': async (req, res) => {
      const user = requireBirdhouse(req);
      const body = await readJson(req, 10000);
      birdhouse.mine(user).prices = birdhouse.cleanPrices(body.prices);
      store.save();
      send(res, 200, { prices: user.birdhouse.prices });
    },

    // One search box: asks every app this user can search, results grouped by app.
    'GET /api/search': async (req, res) => {
      const user = requireUser(req);
      send(res, 200, await search.run(user, new URL(req.url, 'http://roost').searchParams.get('q')));
    },

    // The opener page asks for this browser's Jellyfin sign-in.
    'GET /api/jellyfin/session': async (req, res) => {
      const user = requireUser(req);
      if (!canUseJellyfin(user)) throw new HttpError(403, "You don't have access to Jellyfin");
      const session = sessions.get(tokenOf(req));
      const pending = session && jellyfinLinks.get(session.id);
      if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 4000))]);
      const jf = session && session.jf;
      send(res, 200, jf ? { token: jf.token, userId: jf.userId, serverId: jf.serverId } : {});
    },

    // The dashboard's Continue watching row. Empty, never an error, when
    // Jellyfin isn't linked, isn't answering or there's nothing to resume.
    'GET /api/jellyfin/resume': async (req, res) => {
      const user = requireUser(req);
      let items = [];
      if (jellyfin.enabled() && canUseJellyfin(user)) {
        items = await jellyfin.resume(user.username).catch((err) => { jellyfinFailed(err); return []; });
      }
      send(res, 200, { items });
    },

    'GET /api/admin/jellyfin': async (req, res) => {
      requireAdmin(req);
      send(res, 200, await jellyfinView());
    },

    // Roostflix on or off. Takes effect the next time Jellyfin's page loads.
    'PUT /api/admin/roostflix': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const on = body.on === true;
      if (on) delete db().settings.roostflix;
      else db().settings.roostflix = false;
      store.save();
      send(res, 200, { skin: on });
    },

    // One tap: a Jellyfin account for everyone who lacks one. Each person's
    // own password reaches it the next time they sign in to Roost.
    'POST /api/admin/jellyfin/accounts': async (req, res) => {
      const admin = requireAdmin(req);
      if (!jellyfin.enabled()) throw new HttpError(400, 'Connect Jellyfin first');
      let created;
      try {
        created = await jellyfin.createMissing(jellyfinPeople());
      } catch (err) {
        jellyfinFailed(err);
        throw new HttpError(502, `Jellyfin didn't accept that: ${err.message}`);
      }
      if (created) record(req, 'jellyfin-accounts', { actor: admin.username, detail: `${created} created` });
      send(res, 200, { created, ...(await jellyfinView()) });
    },

    'PUT /api/admin/jellyfin': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const url = str(body.url, 300).replace(/\/+$/, '');
      if (!url) {
        delete db().settings.jellyfin;
        store.save();
        return send(res, 200, await jellyfinView());
      }
      if (!/^https?:\/\/[^\s/]+/.test(url)) throw new HttpError(400, 'Address must start with http:// or https://');
      const old = db().settings.jellyfin || {};
      const apiKey = str(body.apiKey, 100) || old.apiKey;
      if (!apiKey) throw new HttpError(400, 'Paste an API key from Jellyfin');
      db().settings.jellyfin = { url, apiKey };
      jellyfin.cache = null;
      const view = await jellyfinView();
      if (!view.connected) {
        if (old.url) db().settings.jellyfin = old;
        else delete db().settings.jellyfin;
        throw new HttpError(400, `Couldn't reach Jellyfin with that address and key: ${view.error}`);
      }
      store.save();
      send(res, 200, view);
    },

    'GET /api/apps/status': async (req, res) => {
      const user = requireUser(req);
      const host = requestHost(req);
      if (localHost(host)) uptime.setHost(host);
      const entries = await Promise.all(
        appsFor(user).map(async (a) => [a.id, (await galaxyState(a)) || (await appProbe(probeApp(a), host, probeTimeoutMs)).state]),
      );
      const status = Object.fromEntries(entries);
      // Coffee Galaxy's own dot, for its square on the Galaxies page.
      if (coffee.enabled() && entries.some(([id]) => id === 'nova')) status.coffee = (await coffee.health(coffeeOptions.fetchImpl, probeTimeoutMs)).ok ? 'online' : 'offline';
      send(res, 200, { status });
    },

    // Power and heat over the last day, week or month, for the status charts.
    'GET /api/admin/health-history': (req, res) => {
      requireAdmin(req);
      const out = healthHistory.series(new URL(req.url, 'http://roost').searchParams.get('range') || 'day');
      const { price, currency } = priceOf(db().settings);
      send(res, 200, { ...out, cost: money(out.kwh * price, currency) });
    },
    'GET /api/system': (req, res) => {
      requireMember(req);
      // The dashboard shows every drive Roost uses added together; `nest` is the drive
      // Nest keeps its files on, which is what the storage limits are measured against.
      let disk = null;
      let nestDisk = null;
      let drives = [];
      try {
        const nestPath = nestDir || path.join(dataDir, 'nest');
        const read = (label, p) => {
          const s = fs.statfsSync(p);
          return { label, dev: fs.statSync(p).dev, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
        };
        const system = read('System', dataDir);
        let nestDrive = system;
        try {
          nestDrive = read('Nest', nestPath);
        } catch {
          // Nest's folder isn't made yet; it will sit on the same drive as Roost's data.
        }
        const all = nestDrive.dev === system.dev ? [system] : [system, nestDrive];
        drives = all.map(({ label, total, free }) => ({ label, total, free }));
        disk = { total: all.reduce((n, d) => n + d.total, 0), free: all.reduce((n, d) => n + d.free, 0) };
        nestDisk = { total: nestDrive.total, free: nestDrive.free };
      } catch {
        // statfs is unavailable on some platforms; the dashboard just hides it.
      }
      send(res, 200, {
        hostname: os.hostname(),
        uptime: os.uptime(),
        load: os.platform() === 'win32' ? null : os.loadavg(),
        cpus: os.cpus().length,
        memory: { total: os.totalmem(), free: os.freemem() },
        disk,
        nestDisk,
        drives,
        notice: activeNotice(),
      });
    },

    'GET /api/status': async (req, res) => {
      const user = requireMember(req);
      const host = requestHost(req);
      if (localHost(host)) uptime.setHost(host);
      const [health, docker, web] = await Promise.all([
        serverHealth({ cpu, disks: diskList }),
        listContainers(dockerHost, probeTimeoutMs),
        Promise.all(visibleApps(db(), user).map(async (a) => {
          if (a.id !== 'nova' || !novaHasGalaxies()) return appProbe(probeApp(a), host, probeTimeoutMs);
          const galaxies = await novaGalaxies();
          const down = galaxies.filter((g) => g.state !== 'online').length;
          return { state: !down ? 'online' : down === galaxies.length ? 'offline' : 'partial', ms: Math.max(0, ...galaxies.map((g) => g.ms)), galaxies };
        })),
      ]);
      // Update badges are for admins, the only ones who can act on them.
      const updateOf = user.role === 'admin' ? updates.view(docker.containers || []) : {};
      const all = (docker.containers || []).map((c) => (updateOf[c.id] ? { ...c, update: updateOf[c.id] } : c));
      const canRestart = new Set(user.role === 'admin' ? docker.restartable || [] : []);
      const claimed = new Set();
      const claim = (list) => { list.forEach((c) => claimed.add(c.id)); return list; };
      const apps = [
        {
          id: 'roost',
          name: db().settings.serverName,
          tagline: 'Homepage',
          icon: 'home',
          web: { state: 'online', ms: 0 },
          uptime: process.uptime(),
          containers: claim(containersFor({ id: 'roost', container: roostContainer }, all)),
        },
        ...visibleApps(db(), user).map((a, i) => {
          const containers = claim(containersFor(a, all));
          return {
            id: a.id,
            name: shownName(a),
            tagline: a.tagline,
            icon: a.icon,
            web: web[i],
            containers,
            // Admins get a Restart button when the Docker helper lists this app's containers.
            restartSchedule: user.role === 'admin' ? a.restartSchedule || null : undefined,
            restartable: containers.some((c) => canRestart.has(c.name) && c.name !== roostContainer),
          };
        }),
      ];
      send(res, 200, {
        ...health,
        docker: docker.error ? { ok: false, error: docker.error } : { ok: true },
        driveHealth: driveHealth.read(),
        // Power, CPU heat and the hottest drive, for admins only.
        sensors: user.role === 'admin' ? sensors.view({ driveHealth: driveHealth.read(), settings: db().settings }) : null,
        // Whether the roost-smart helper can be built from here, for admins only.
        helper: user.role === 'admin' ? helperSummary() : null,
        // Wear and sector trends per drive, for admins only.
        driveOutlook: user.role === 'admin' ? driveTrends.outlooks(healthHistory, (driveHealth.read() || {}).drives, Date.now()) : null,
        apps,
        // Everything else Docker runs, for admins only.
        otherContainers: user.role === 'admin' ? all.filter((c) => !claimed.has(c.id)) : [],
        // What left the house, for admins only.
        traffic: user.role === 'admin' ? traffic.summary() : null,
        // Certificate health, for admins once HTTPS is set up.
        certificate: user.role === 'admin' ? certSummary() : null,
        // Cloudflare, Let's Encrypt and Docker Hub at a glance, for admins only.
        outside: user.role === 'admin' ? outside.view({ containers: docker.error ? null : all, cert: certs.status() }) : null,
        history: uptime.history(visibleApps(db(), user).map((a) => a.id)),
        checkedAt: new Date().toISOString(),
      });
    },

    // Restarts the app's containers that Roost's Docker helper allows. Roost
    // itself is never restarted from here: the page would lose its answer.
    'POST /api/admin/apps/:id/restart': async (req, res, id) => {
      const admin = requireAdmin(req);
      const app = db().apps.find((a) => a.id === id);
      if (!app) throw new HttpError(404, 'No such app');
      try {
        const names = await restartApp(app, 30 * 1000);
        record(req, 'app-restarted', { actor: admin.username, detail: `${app.name} (${names.join(', ')})` });
      } catch (err) {
        if (!err.restartFailed) throw err;
        record(req, 'app-restart-failed', { actor: admin.username, detail: `${app.name}: ${err.cause.message}` });
        throw new HttpError(502, `${app.name} didn't restart (${err.cause.message})`);
      }
      send(res, 200, { ok: true });
    },

    'POST /api/admin/updates/check': async (req, res) => {
      requireAdmin(req);
      const docker = await listContainers(dockerHost, probeTimeoutMs);
      if (docker.error) throw new HttpError(503, "Roost can't see Docker");
      if (!(await updates.checkNow(docker.containers))) throw new HttpError(429, 'Checked a moment ago');
      send(res, 200, { ok: true });
    },

    'GET /api/admin/users': (req, res) => {
      requireAdmin(req);
      send(res, 200, { users: db().users.map(adminView) });
    },

    'POST /api/admin/users': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      if (!validUsername(username)) throw new HttpError(400, 'Username: 2–32 of a–z, 0–9, . _ -');
      if (db().users.some((u) => u.username === username)) throw new HttpError(409, 'That username is taken');
      if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
      const user = {
        id: store.newId(),
        username,
        displayName: str(body.displayName, 60) || username,
        role: cleanRole(body.role),
        apps: cleanAppAccess(body.apps),
        limitGb: body.limitGb === undefined ? storage.defaultLimitGb(db()) : cleanLimit(body.limitGb),
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };
      if (user.role === 'guest') user.guestUntil = cleanGuestUntil(body.guestUntil);
      db().users.push(user);
      store.save();
      syncJellyfinPassword(user, body.password);
      record(req, 'user-added', { actor: admin.username, target: user.username, detail: `${user.role}, ${gbText(user.limitGb)}` });
      send(res, 201, { user: adminView(user) });
    },

    'PATCH /api/admin/users/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const user = db().users.find((u) => u.id === id);
      if (!user) throw new HttpError(404, 'No such user');
      const body = await readJson(req);
      const changes = [];
      if (body.displayName !== undefined) {
        const name = str(body.displayName, 60) || user.username;
        if (name !== user.displayName) changes.push('name');
        user.displayName = name;
      }
      if (body.apps !== undefined) {
        const apps = cleanAppAccess(body.apps);
        if (JSON.stringify(apps) !== JSON.stringify(user.apps)) changes.push('app access');
        user.apps = apps;
      }
      if (body.limitGb !== undefined) {
        const limit = cleanLimit(body.limitGb);
        const before = storage.limitGbOf(db(), user);
        if (limit !== before) changes.push(`limit ${gbText(before)} → ${gbText(limit)}`);
        user.limitGb = limit;
      }
      if (body.role !== undefined) {
        const role = cleanRole(body.role);
        if (user.id === admin.id && role !== 'admin') throw new HttpError(400, "You can't remove your own admin role");
        if (role === 'guest' && user.role !== 'guest' && body.guestUntil === undefined) throw new HttpError(400, 'Pick when the guest pass ends');
        if (role !== user.role) changes.push(`role ${user.role} → ${role}`);
        user.role = role;
        if (role !== 'guest') delete user.guestUntil;
      }
      if (user.role === 'guest' && body.endGuestPass === true) {
        user.guestUntil = new Date().toISOString();
        sessions.destroyUser(user.id);
        changes.push('guest pass ended');
      } else if (user.role === 'guest' && body.guestUntil !== undefined) {
        user.guestUntil = cleanGuestUntil(body.guestUntil);
        changes.push(`guest pass until ${user.guestUntil.slice(0, 10)}`);
      }
      if (body.password !== undefined) {
        if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.password);
        user.trusted = [];
        sessions.destroyUser(user.id);
        syncJellyfinPassword(user, body.password);
        changes.push('password reset');
      }
      // For someone who lost their phone and their recovery codes: they sign
      // in with just their password and set it up again.
      if (body.resetTwoStep === true && user.twoStep) {
        delete user.twoStep;
        user.trusted = [];
        changes.push('two-step reset');
      }
      if (body.apps !== undefined || body.role !== undefined) jellyfinAccessChanged(user, body.role !== undefined);
      store.save();
      if (changes.length) record(req, 'user-changed', { actor: admin.username, target: user.username, detail: changes.join(', ') });
      send(res, 200, { user: adminView(user) });
    },

    'DELETE /api/admin/users/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      if (id === admin.id) throw new HttpError(400, "You can't delete yourself");
      const gone = db().users.find((u) => u.id === id);
      if (!gone) throw new HttpError(404, 'No such user');
      db().users = db().users.filter((u) => u.id !== id);
      sessions.destroyUser(id);
      if (jellyfin.enabled()) jellyfin.disable(gone.username).catch(jellyfinFailed);
      db().links = (db().links || []).filter((l) => l.userId !== id);
      db().storageRequests = storage.requestsOf(db()).filter((r) => r.userId !== id);
      db().movieRequests = movieRequests().filter((r) => r.userId !== id);
      const fam = family.familyOf(db());
      fam.members = fam.members.filter((m) => m !== id);
      store.save();
      record(req, 'user-removed', { actor: admin.username, target: gone.username });
      send(res, 200, { ok: true });
    },

    // ---------- family ----------

    'GET /api/admin/family': (req, res) => {
      requireAdmin(req);
      send(res, 200, { family: familyView() });
    },

    'PUT /api/admin/family': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const fam = family.familyOf(db());
      const changes = [];
      if (body.members !== undefined) {
        const members = family.cleanMembers(db(), body.members);
        if (!members) throw new HttpError(400, 'Members must be a list of users');
        const name = (id) => db().users.find((u) => u.id === id).username;
        const added = members.filter((m) => !fam.members.includes(m)).map(name);
        const removed = fam.members.filter((m) => !members.includes(m) && db().users.some((u) => u.id === m)).map(name);
        if (added.length) changes.push(`added ${added.join(', ')}`);
        if (removed.length) changes.push(`removed ${removed.join(', ')}`);
        fam.members = members;
      }
      if (body.limitGb !== undefined) {
        const limit = cleanLimit(body.limitGb);
        if (limit !== fam.limitGb) changes.push(`limit ${gbText(fam.limitGb)} → ${gbText(limit)}`);
        fam.limitGb = limit;
      }
      store.save();
      if (changes.length) record(req, 'family-changed', { actor: admin.username, detail: changes.join(', ') });
      send(res, 200, { family: familyView() });
    },

    // ---------- invite and reset links ----------

    'GET /api/admin/invites': (req, res) => {
      requireAdmin(req);
      if (links.prune(db())) store.save();
      const invites = db().links.filter((l) => l.kind === 'invite').map(links.adminView);
      send(res, 200, { invites, publicUrl: db().settings.publicUrl || '' });
    },

    'POST /api/admin/invites': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const role = cleanRole(body.role);
      const { token, link } = links.create(db(), {
        id: store.newId(),
        kind: 'invite',
        label: str(body.label, 60),
        role,
        apps: role === 'admin' ? null : cleanAppAccess(body.apps),
        limitGb: body.limitGb === undefined ? storage.defaultLimitGb(db()) : cleanLimit(body.limitGb),
        ...(role === 'guest' ? { guestUntil: cleanGuestUntil(body.guestUntil) } : {}),
        createdBy: admin.id,
      }, links.INVITE_TTL_MS);
      store.save();
      const out = { invite: links.adminView(link), token };
      const to = str(body.email, 254).toLowerCase();
      if (to) {
        if (!mail.validEmail(to)) out.mailError = "That doesn't look like an email address";
        else if (!mailReady()) out.mailError = 'Email is not set up yet';
        else {
          try {
            await deliver(to, ...inviteEmail(admin, token));
            out.emailedTo = to;
          } catch (err) { out.mailError = err.message; }
        }
      }
      record(req, 'invite-created', { actor: admin.username, detail: [link.label, role, out.emailedTo && `emailed to ${out.emailedTo}`].filter(Boolean).join(', ') });
      send(res, 201, out);
    },

    'DELETE /api/admin/invites/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      const link = (db().links || []).find((l) => l.kind === 'invite' && l.id === id);
      if (!link) throw new HttpError(404, 'No such invite');
      links.remove(db(), link);
      store.save();
      record(req, 'invite-removed', { actor: admin.username, detail: link.label || '' });
      send(res, 200, { ok: true });
    },

    'POST /api/admin/users/:id/reset-link': async (req, res, id) => {
      const admin = requireAdmin(req);
      const user = db().users.find((u) => u.id === id);
      if (!user) throw new HttpError(404, 'No such user');
      const body = req.headers['content-type'] ? await readJson(req) : {};
      const { token, link } = newResetLink(user, admin.id, links.RESET_TTL_MS);
      store.save();
      const out = { expiresAt: link.expiresAt, token };
      if (body.email) {
        if (!user.email) out.mailError = `${user.displayName} hasn't added an email address`;
        else if (!mailReady()) out.mailError = 'Email is not set up yet';
        else {
          try {
            await deliver(user.email, ...resetEmail(user, token, '24 hours'));
            out.emailedTo = user.email;
          } catch (err) { out.mailError = err.message; }
        }
      }
      record(req, 'reset-link-created', { actor: admin.username, target: user.username, detail: out.emailedTo ? `emailed to ${out.emailedTo}` : '' });
      send(res, 201, out);
    },

    // "Forgot password?" on the sign-in page. The answer is always the same,
    // so it can't be used to find out who has an account.
    'POST /api/forgot': async (req, res) => {
      // Every request counts here, not only misses, since each one can send an email.
      const key = `forgot:${clientIp(req, trustProxy)}`;
      if (!limiter.allow(key)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      limiter.fail(key);
      const body = await readJson(req);
      const login = str(body.login, 254).toLowerCase();
      send(res, 200, { ok: true });
      const user = login && db().users.find((u) => u.username === login || (u.email && u.email === login));
      if (!user || !user.email || !mailReady()) return;
      // At most one email per user every 5 minutes.
      if (Date.now() - (forgotSentAt.get(user.id) || 0) < 5 * 60 * 1000) return;
      forgotSentAt.set(user.id, Date.now());
      const { token } = newResetLink(user, null, links.FORGOT_TTL_MS);
      store.save();
      deliver(user.email, ...resetEmail(user, token, '1 hour')).catch((err) => console.error(`Reset email to @${user.username} failed: ${err.message}`));
    },

    // ---------- backups ----------

    // The dashboard line. Everyone sees how backups are doing; only admins
    // see why one failed and what the drive holds.
    'GET /api/backup': (req, res) => {
      const user = requireMember(req);
      const status = backup.readStatus(dataDir);
      const out = backup.summarize(status);
      if (user.role !== 'admin') {
        send(res, 200, { state: out.state, lastOk: out.lastOk || null });
        return;
      }
      send(res, 200, {
        ...out,
        drive: status && status.drive,
        last: status && status.last,
        snapshots: status ? status.snapshots : [],
      });
    },

    // Admin → Apps → Add app. Docker is only asked when the picker opens.
    'GET /api/admin/app-templates': async (req, res) => {
      requireAdmin(req);
      const docker = await listContainers(dockerHost, probeTimeoutMs);
      send(res, 200, {
        docker: docker.error ? { ok: false, error: docker.error } : { ok: true },
        running: templates.suggestions(db().apps, docker.containers || [], roostContainer),
        templates: templates.templates(),
      });
    },

    // Admin → Backups: everything the card shows, in one call.
    'GET /api/admin/backup': (req, res) => {
      requireAdmin(req);
      const status = backup.readStatus(dataDir);
      const snapshots = status && status.snapshots ? status.snapshots : [];
      send(res, 200, {
        ...backup.summarize(status),
        config: backup.config(db().settings.backup),
        drive: status && status.drive,
        last: status && status.last,
        history: status && status.history ? status.history : [],
        snapshots: { count: snapshots.length, newest: snapshots[0] ? snapshots[0].at : null, oldest: snapshots.length ? snapshots[snapshots.length - 1].at : null },
        requested: backup.hasRequest(dataDir),
      });
    },

    // "Back up now" and "Cancel" leave a request for the backup service.
    'POST /api/admin/backup/run': (req, res) => {
      const admin = requireAdmin(req);
      const { state, message } = backup.summarize(backup.readStatus(dataDir));
      if (state === 'off' || state === 'stopped') throw new HttpError(409, 'The backup service isn’t running. Check that roost-backup is started.');
      if (state === 'running') throw new HttpError(409, 'A backup is already running');
      if (state === 'drive') throw new HttpError(409, message || 'Backup drive not found');
      backup.writeRequest(dataDir, 'run');
      record(req, 'settings-changed', { actor: admin.username, detail: 'backup started by hand' });
      send(res, 202, { ok: true });
    },

    'POST /api/admin/backup/cancel': (req, res) => {
      const admin = requireAdmin(req);
      if (backup.summarize(backup.readStatus(dataDir)).state !== 'running') throw new HttpError(409, 'No backup is running');
      backup.writeRequest(dataDir, 'cancel');
      record(req, 'settings-changed', { actor: admin.username, detail: 'backup cancelled' });
      send(res, 202, { ok: true });
    },

    // ---------- updating Roost ----------
    // the Status page's Update card. Roost only leaves requests for the roost-updater service
    // and reads what it reports; it never runs git or Docker itself.

    'GET /api/admin/update': (req, res) => {
      requireAdmin(req);
      const summary = selfUpdate.summarize(selfUpdate.readStatus(dataDir));
      // Write an update's outcome to the activity log, once.
      const last = summary.last;
      if (last && last.finishedAt && selfUpdate.lastLogged(dataDir) !== last.finishedAt && !last.nothing) {
        selfUpdate.markLogged(dataDir, last.finishedAt);
        record(req, 'settings-changed', {
          target: 'roost-updater',
          detail: last.ok
            ? `Roost updated to ${String(last.to).slice(0, 7)} (${last.count} ${last.count === 1 ? 'change' : 'changes'})`
            : `Roost update ${last.rolledBack ? 'failed and was rolled back' : 'failed'}: ${last.error}`,
        });
      }
      send(res, 200, { ...summary, requested: selfUpdate.hasRequest(dataDir) });
    },

    'POST /api/admin/update/check': (req, res) => {
      requireAdmin(req);
      const { state } = selfUpdate.summarize(selfUpdate.readStatus(dataDir));
      if (state === 'off' || state === 'stopped') throw new HttpError(409, 'The updater isn’t running. Check that roost-updater is started.');
      if (state === 'applying') throw new HttpError(409, 'Roost is being updated right now');
      selfUpdate.writeRequest(dataDir, 'check');
      send(res, 202, { ok: true });
    },

    'POST /api/admin/update/apply': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      // The button asks first; the server insists on the answer too.
      if (body.confirm !== true) throw new HttpError(400, 'Confirm the update first');
      const summary = selfUpdate.summarize(selfUpdate.readStatus(dataDir));
      if (selfUpdate.hasRequest(dataDir) || summary.state === 'applying') throw new HttpError(409, 'An update is already on its way');
      if (summary.state === 'off' || summary.state === 'stopped') throw new HttpError(409, 'The updater isn’t running. Check that roost-updater is started.');
      if (summary.state !== 'available') throw new HttpError(409, 'There is nothing new to update to');
      if (summary.conflicts.length) throw new HttpError(409, `You changed ${summary.conflicts.join(', ')} on the server, and this update changes it too. Move your own settings into docker-compose.override.yml first.`);
      selfUpdate.writeRequest(dataDir, 'apply');
      record(req, 'settings-changed', { actor: admin.username, detail: `Roost update started (${summary.behind} ${summary.behind === 1 ? 'change' : 'changes'})` });
      send(res, 202, { ok: true });
    },

    // Builds the roost-smart helper once, for the Power and heat section.
    'POST /api/admin/helper/rebuild': (req, res) => {
      const admin = requireAdmin(req);
      const helper = helperSummary();
      if (helper.building || selfUpdate.summarize(selfUpdate.readStatus(dataDir)).state === 'applying') throw new HttpError(409, 'The updater is busy. Try again in a minute.');
      if (!helper.capable) throw new HttpError(409, 'The updater can’t do this yet. Run once in the server terminal: cd /DATA/AppData/roost-src && sudo docker compose up -d --build roost-updater roost-smart');
      selfUpdate.writeRequest(dataDir, 'helper');
      record(req, 'settings-changed', { actor: admin.username, detail: 'Power and heat helper rebuild started' });
      send(res, 202, { ok: true });
    },

    // ---------- which drive Nest keeps its files on ----------
    // Admin → Storage. Roost leaves a request for the roost-updater service,
    // which lists the plugged-in drives and switches Nest's folder over.

    'GET /api/admin/nest-drive': (req, res) => {
      requireAdmin(req);
      const status = nestDrive.readStatus(dataDir);
      const updater = selfUpdate.summarize(selfUpdate.readStatus(dataDir)).state;
      // Keep the drive list fresh without polling: look again when the card is opened.
      if (updater !== 'off' && updater !== 'stopped' && nestDrive.stale(status) && !nestDrive.hasRequest(dataDir)) {
        nestDrive.writeRequest(dataDir, { action: 'list' });
      }
      const summary = nestDrive.summarize(status, nestDir || path.join(dataDir, 'nest'));
      send(res, 200, { ...summary, updater, requested: nestDrive.hasRequest(dataDir), waitedMs: nestDrive.requestAge(dataDir) });
    },

    // "Look again", for when the first look got no answer.
    'POST /api/admin/nest-drive/refresh': (req, res) => {
      requireAdmin(req);
      const updater = selfUpdate.summarize(selfUpdate.readStatus(dataDir)).state;
      if (updater === 'off' || updater === 'stopped') throw new HttpError(409, 'The updater isn’t running. Check that roost-updater is started.');
      nestDrive.writeRequest(dataDir, { action: 'list' });
      send(res, 202, { ok: true });
    },

    'POST /api/admin/nest-drive/move': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, 'Confirm the move first');
      const drive = String(body.drive || '');
      const updater = selfUpdate.summarize(selfUpdate.readStatus(dataDir)).state;
      if (updater === 'off' || updater === 'stopped') throw new HttpError(409, 'The updater isn’t running. Check that roost-updater is started.');
      if (updater === 'applying') throw new HttpError(409, 'Roost is being updated right now');
      const status = nestDrive.readStatus(dataDir);
      if (nestDrive.hasRequest(dataDir) || (status && status.state === 'moving')) throw new HttpError(409, 'A move is already on its way');
      const summary = nestDrive.summarize(status, nestDir || path.join(dataDir, 'nest'));
      if (summary.state === 'off') throw new HttpError(409, 'Roost hasn’t seen the drives yet. Try again in a moment.');
      if (!summary.empty) throw new HttpError(409, 'Nest already has files in it, so they would need copying across first. See the guide in the README.');
      if (!summary.drives.some((d) => d.name === drive)) throw new HttpError(404, 'That drive isn’t plugged in');
      nestDrive.writeRequest(dataDir, { action: 'move', drive });
      record(req, 'settings-changed', { actor: admin.username, target: 'nest', detail: `Moving Nest to the drive “${drive}”` });
      send(res, 202, { ok: true });
    },

    // ---------- restoring from a backup ----------
    // Everything here is admin-only and read-only on the backup drive. Getting
    // files back never overwrites anything: it is a download, or a new folder
    // in the person's Nest.

    // Browse a night like a folder tree.
    'GET /api/admin/backup/browse': async (req, res) => {
      requireAdmin(req);
      const q = new URL(req.url, 'http://roost').searchParams;
      const nights = backups.nights();
      if (!backupDir || !nights.length) {
        send(res, 200, { available: false, reason: !backupDir ? 'not-mounted' : 'no-backups', nights: [] });
        return;
      }
      const night = await backups.night(q.get('snapshot') || nights[0].name);
      const p = restore.cleanPath(q.get('path'));
      if (!night || p === null || night.kind(p) !== 'folder') throw new HttpError(404, 'That folder isn’t in this backup');
      const listing = night.list(p);
      const here = restore.parts(p);
      // Whose Nest an item would be restored into, when it is in someone's files.
      const personOf = (segs) => {
        const o = nestOwner(segs, true);
        return o ? o.displayName || o.username : null;
      };
      const label = (segs) => {
        // Nest/<username>_<id> shows as the person's name.
        if (segs[0] === 'Nest' && segs.length === 2) {
          const owner = nestOwner(segs);
          return owner ? owner.displayName || owner.username : null;
        }
        return null;
      };
      send(res, 200, {
        available: true,
        nights: nights.map((n) => ({ name: n.name, at: n.at.toISOString() })),
        snapshot: { name: night.name, files: night.count, bytes: night.bytes },
        path: here.map((name, i) => ({ name, label: label(here.slice(0, i + 1)) })),
        folders: listing.folders.map((f) => ({ ...f, label: label([...here, f.name]), restoreFor: personOf([...here, f.name]) })),
        files: listing.files.map((f) => ({ ...f, restoreFor: personOf([...here, f.name]) })),
        restoreTo: personOf(here) ? { name: personOf(here) } : null,
        job: restoreJob,
      });
    },

    // A file as it was, or a folder as a zip.
    'GET /api/admin/backup/download': async (req, res) => {
      requireAdmin(req);
      const q = new URL(req.url, 'http://roost').searchParams;
      const night = await backups.night(q.get('snapshot') || '');
      const p = restore.cleanPath(q.get('path'));
      const kind = night && p ? night.kind(p) : null;
      if (!kind) throw new HttpError(404, 'That isn’t in this backup');
      const last = p.slice(p.lastIndexOf('/') + 1);
      if (kind === 'file') {
        const entry = night.under(p)[0];
        // gzipped files are stored smaller than they are, so no Content-Length for them
        const name = last;
        const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition(name), 'Cache-Control': 'no-store' };
        if (!entry[4]) headers['Content-Length'] = entry[1];
        res.writeHead(200, headers);
        try {
          await require('stream/promises').pipeline(night.open(entry), res);
        } catch (err) {
          console.error('Backup download stopped:', err.message);
          res.destroy();
        }
        return;
      }
      const base = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      const files = night.under(p);
      const plan = zip.plan(files.map((f) => ({ name: f[0].slice(base.length), open: () => night.open(f), size: f[1], mtime: f[2] })));
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': disposition(`${last || 'Roost backup'} (backup ${night.name}).zip`),
        'Content-Length': plan.total,
        'Cache-Control': 'no-store',
      });
      try {
        await zip.streamZip(res, plan);
      } catch (err) {
        console.error('Backup zip stopped:', err.message);
        res.destroy();
      }
    },

    // Puts a person's files from a backup into a new folder in their Nest.
    'POST /api/admin/backup/restore': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      if (restoreJob && restoreJob.running) throw new HttpError(409, 'A restore is already running');
      const night = await backups.night(str(body.snapshot, 40));
      const p = restore.cleanPath(body.path);
      const segs = restore.parts(p);
      const owner = night && p ? nestOwner(segs, true) : null;
      if (!night || !p || !night.kind(p)) throw new HttpError(404, 'That isn’t in this backup');
      if (!owner) throw new HttpError(400, 'Only a person’s Nest files can be restored here. Download the rest instead.');
      // Everything under what was picked, named from the picked item on down;
      // the whole "files" folder restores its contents straight into the new folder.
      const entries = night.under(p);
      const cut = segs.length === 3 ? p.length + 1 : p.length - segs[segs.length - 1].length;
      const files = entries.map((f) => ({ rel: f[0].slice(cut), size: f[1], mtime: f[2], open: () => night.open(f) }));
      const folderName = `Restored from backup ${night.name}`;
      const total = files.reduce((a, f) => a + f.size, 0);
      // Space is checked before anything is made, so a refusal leaves no trace.
      nest.checkSpace(owner, total);
      const job = { running: true, snapshot: night.name, path: p, person: owner.displayName || owner.username, files: 0, total: files.length, bytes: 0, totalBytes: total, folder: null, error: null, startedAt: new Date().toISOString() };
      restoreJob = job;
      record(req, 'settings-changed', { actor: admin.username, target: owner.username, detail: `restored ${segs[segs.length - 1]} from backup ${night.name} into ${owner.username}'s Nest` });
      nest.importFolder(owner, folderName, files, {
        onFile: (f, n) => { job.files = n; job.bytes += f.size; },
      }).then((top) => { job.folder = top.name; }).catch((err) => {
        job.error = err.status ? err.message : `Stopped: ${err.message}`;
        console.error('Restore from backup failed:', err);
      }).finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); });
      send(res, 202, { job });
    },

    'GET /api/admin/backup/restore': (req, res) => {
      requireAdmin(req);
      send(res, 200, { job: restoreJob });
    },

    // ---------- setup checklist ----------

    'GET /api/admin/setup': async (req, res) => {
      const admin = requireAdmin(req);
      const docker = await listContainers(dockerHost, probeTimeoutMs);
      send(res, 200, await setup.checklist({
        db: db(),
        admin,
        nestDir: nestDir || path.join(dataDir, 'nest'),
        drives: readDisks(diskList),
        driveHealth: driveHealth.read(),
        sensors: sensors.view({ driveHealth: driveHealth.read(), settings: db().settings }),
        dockerOk: !docker.error,
        restartable: docker.restartable || [],
        secureCookies,
        trustProxy,
        awayBytes: Object.values(traffic.summary().apps).reduce((n, a) => n + a.week, 0),
        tls: certs.status(),
        remote: remote.view(),
        coffee: coffeeView(),
        galaxies: galaxiesView(),
        ticked: db().settings.setupTicked || [],
        backup: backup.readStatus(dataDir),
        update: selfUpdate.summarize(selfUpdate.readStatus(dataDir)),
      }));
    },

    // Steps Roost can't check itself (they live in Cloudflare) are ticked by hand.
    'POST /api/admin/setup/:id': async (req, res, id) => {
      requireAdmin(req);
      if (!setup.MANUAL.includes(id)) throw new HttpError(400, 'Roost checks that step itself');
      const body = await readJson(req);
      const ticked = new Set(db().settings.setupTicked || []);
      if (body.done) ticked.add(id);
      else ticked.delete(id);
      db().settings.setupTicked = [...ticked];
      store.save();
      send(res, 200, { ok: true });
    },

    'GET /api/admin/settings': (req, res) => {
      requireAdmin(req);
      send(res, 200, { settings: settingsView() });
    },

    'POST /api/admin/mail-test': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const to = str(body.to, 254).toLowerCase() || admin.email;
      if (!mail.validEmail(to)) throw new HttpError(400, 'Add your email on Profile first, or type one here');
      if (!mailSettings()) throw new HttpError(400, 'Save the email settings first');
      try {
        const name = db().settings.serverName;
        await deliver(to, `Test email from ${name}`, `This is a test from ${name}. Email is working.`, emailTemplate.render({ title: 'Email is working', paragraphs: [`This is a test from ${name}. If you can read this, invites and password resets will reach people.`] }));
      } catch (err) {
        throw new HttpError(502, err.message);
      }
      mailSettings().verifiedAt = new Date().toISOString();
      store.save();
      send(res, 200, { ok: true, to });
    },

    // The page a link opens asks what it is for, and (for invites) whether a
    // username is free while the person types it.
    'GET /api/links/:id': (req, res, token) => {
      const link = openLink(req, token);
      if (link.kind === 'reset') {
        const user = db().users.find((u) => u.id === link.userId);
        return send(res, 200, { kind: 'reset', serverName: db().settings.serverName, username: user.username, displayName: user.displayName });
      }
      const wanted = new URL(req.url, 'http://roost').searchParams.get('username');
      if (wanted !== null) return send(res, 200, usernameCheck(wanted.toLowerCase()));
      const inviter = db().users.find((u) => u.id === link.createdBy);
      const apps = link.role === 'admin' ? db().apps : Array.isArray(link.apps) ? db().apps.filter((a) => link.apps.includes(a.id)) : db().apps.filter((a) => !a.adminOnly);
      send(res, 200, {
        kind: 'invite',
        serverName: db().settings.serverName,
        invitedBy: inviter ? inviter.displayName : null,
        role: link.role,
        apps: apps.map((a) => a.name),
        expiresAt: link.expiresAt,
        guestUntil: link.guestUntil,
      });
    },

    'POST /api/links/:id': async (req, res, token) => {
      const link = openLink(req, token);
      const body = await readJson(req);
      // Reading the body takes a moment: a second request with the same link may
      // have used it up meanwhile, and one link must only ever make one account.
      if (!(db().links || []).includes(link)) throw new HttpError(404, 'This link has expired or was already used');
      if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
      if (link.kind === 'reset') {
        const user = db().users.find((u) => u.id === link.userId);
        user.password = hashPassword(body.password);
        sessions.destroyUser(user.id);
        links.remove(db(), link);
        store.save();
        record(req, 'password-reset', { actor: user.username, target: user.username, detail: 'reset link' });
        return login(req, res, user, { password: body.password });
      }
      if (link.role === 'guest' && !(Date.parse(link.guestUntil) > Date.now())) throw new HttpError(410, 'This guest pass has already ended');
      const username = str(body.username, 32).toLowerCase();
      const check = usernameCheck(username);
      if (!check.available) throw new HttpError(check.taken ? 409 : 400, check.reason);
      const user = {
        id: store.newId(),
        username,
        displayName: str(body.displayName, 60) || username,
        role: link.role,
        apps: link.apps,
        limitGb: link.limitGb,
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
        invitedBy: link.createdBy,
      };
      if (link.role === 'guest') user.guestUntil = link.guestUntil;
      if (body.email) user.email = cleanEmail(body.email);
      db().users.push(user);
      links.remove(db(), link);
      store.save();
      const inviter = db().users.find((u) => u.id === link.createdBy);
      record(req, 'user-joined', { actor: user.username, detail: inviter ? `invited by ${inviter.username}` : 'invite link' });
      login(req, res, user, { status: 201, password: body.password });
    },

    'PUT /api/admin/apps': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const before = new Map(db().apps.map((a) => [a.id, a]));
      const apps = cleanApps(body.apps);
      // A schedule for an app Roost can't restart would only fail every night.
      const docker = apps.some((a) => a.restartSchedule) ? await listContainers(dockerHost, probeTimeoutMs) : { error: 'skipped' };
      if (!docker.error) {
        for (const a of apps) {
          const same = JSON.stringify(a.restartSchedule) === JSON.stringify((before.get(a.id) || {}).restartSchedule);
          const ok = containersFor(a, docker.containers).some((c) => docker.restartable.includes(c.name) && c.name !== roostContainer);
          if (a.restartSchedule && !same && !ok) throw new HttpError(400, `${a.name} isn't on the restart list, so it can't restart on a schedule (see Admin → Setup)`);
        }
      }
      db().apps = apps;
      const after = new Set(db().apps.map((a) => a.id));
      const changes = [
        ...db().apps.filter((a) => !before.has(a.id)).map((a) => `added ${a.name}`),
        ...[...before.values()].filter((a) => !after.has(a.id)).map((a) => `removed ${a.name}`),
        ...db().apps.filter((a) => before.has(a.id) && JSON.stringify(a) !== JSON.stringify(before.get(a.id))).map((a) => `edited ${a.name}`),
      ];
      if (changes.length) record(req, 'apps-changed', { actor: admin.username, detail: changes.join(', ') });
      const ids = new Set(db().apps.map((a) => a.id));
      for (const u of db().users) if (Array.isArray(u.apps)) u.apps = u.apps.filter((a) => ids.has(a));
      store.save();
      for (const u of db().users) jellyfinAccessChanged(u);
      send(res, 200, { apps: db().apps });
    },

    'GET /api/admin/settings': (req, res) => {
      requireAdmin(req);
      send(res, 200, { settings: settingsView() });
    },

    'PATCH /api/admin/settings': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const changes = [];
      if (body.serverName !== undefined) {
        const name = str(body.serverName, 40) || 'Roost';
        if (name !== db().settings.serverName) changes.push(`name ${db().settings.serverName} → ${name}`);
        db().settings.serverName = name;
      }
      if (body.defaultLimitGb !== undefined) {
        const limit = cleanLimit(body.defaultLimitGb);
        const before = storage.defaultLimitGb(db());
        if (limit !== before) changes.push(`default limit ${gbText(before)} → ${gbText(limit)}`);
        db().settings.defaultLimitGb = limit;
      }
      if (body.publicUrl !== undefined) {
        const url = cleanPublicUrl(body.publicUrl);
        if (url !== (db().settings.publicUrl || '')) changes.push(`public address ${url || 'cleared'}`);
        db().settings.publicUrl = url;
      }
      if (body.adminsNeedTwoStep !== undefined) {
        const need = body.adminsNeedTwoStep !== false;
        if (need !== adminsNeedTwoStep(db())) changes.push(need ? 'admins must use two-step' : 'admins may skip two-step');
        db().settings.adminsNeedTwoStep = need;
      }
      if (body.publicLinks !== undefined) {
        const on = body.publicLinks !== false;
        if (on !== (db().settings.publicLinks !== false)) changes.push(on ? 'public file links on' : 'public file links off');
        db().settings.publicLinks = on;
      }
      if (body.birdhouseFetch !== undefined) {
        const on = body.birdhouseFetch === true;
        if (on !== (db().settings.birdhouseFetch === true)) changes.push(on ? 'Birdhouse may fetch prices' : 'Birdhouse fetching prices off');
        db().settings.birdhouseFetch = on;
      }
      if (body.mail !== undefined) {
        db().settings.mail = cleanMail(body.mail, mailSettings());
        changes.push(`email ${db().settings.mail ? `via ${db().settings.mail.host}` : 'turned off'}`);
      }
      if (body.energyPrice === '' || body.energyPrice === null) {
        delete db().settings.energyPrice; // back to the built-in default
      } else if (body.energyPrice !== undefined) {
        const n = Number(body.energyPrice);
        if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'Electricity price must be a number from 0 to 1000 (pence per kWh)');
        db().settings.energyPrice = +n.toFixed(2);
        changes.push('electricity price');
      }
      if (body.energyCurrency !== undefined) {
        const c = String(body.energyCurrency).trim();
        if (!c || c.length > 3) throw new HttpError(400, 'Currency symbol must be 1 to 3 characters');
        db().settings.energyCurrency = c;
      }
      const alertsBefore = alertSettings(db());
      if (body.alertApps !== undefined) db().settings.alertApps = body.alertApps === true;
      if (body.alertDisks !== undefined) db().settings.alertDisks = body.alertDisks === true;
      if (body.alertDiskPct !== undefined) db().settings.alertDiskPct = cleanDiskPct(body.alertDiskPct);
      if (body.alertSecurity !== undefined) db().settings.alertSecurity = body.alertSecurity === true;
      if (body.alertDriveTrend !== undefined) db().settings.alertDriveTrend = body.alertDriveTrend === true;
      const alertsChanged = JSON.stringify(alertsBefore) !== JSON.stringify(alertSettings(db()));
      if (alertsChanged) changes.push('alert settings');
      let tellBackups = false;
      if (body.backup !== undefined) {
        let next;
        try {
          next = backup.cleanConfig(body.backup);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        if (JSON.stringify(next) !== JSON.stringify(backup.config(db().settings.backup))) {
          changes.push(`backups ${next.time}, keep ${next.keepDaily} nightly + ${next.keepWeekly} weekly${next.capGb ? `, up to ${next.capGb} GB` : ''}`);
          tellBackups = true;
        }
        db().settings.backup = next;
      }
      store.save();
      // The backup service picks the new settings up within a few seconds.
      if (tellBackups) backup.writeRequest(dataDir, 'reload');
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: changes.join(', ') });
      // Check again now, so the bell matches the new settings straight away.
      if (alertsChanged) await watcher.check().catch(() => {});
      send(res, 200, { settings: settingsView() });
    },

    // ---------- alerts ----------

    'GET /api/push/key': (req, res) => {
      requireAdmin(req);
      send(res, 200, { publicKey: push.publicKey() });
    },

    'GET /api/push/devices': (req, res) => {
      const admin = requireAdmin(req);
      send(res, 200, { devices: push.devicesOf(admin.id).map(pushDeviceView) });
    },

    // A phone or PC turning alerts on. Sending the same device again just
    // refreshes it, so the page can safely re-send what the browser holds.
    'POST /api/push/devices': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const before = push.devicesOf(admin.id).length;
      let device;
      try {
        device = push.subscribe(admin.id, body.subscription, { userAgent: req.headers['user-agent'], host: requestHost(req) });
      } catch (err) {
        throw new HttpError(err.status || 400, err.message);
      }
      if (push.devicesOf(admin.id).length > before) record(req, 'settings-changed', { actor: admin.username, detail: `phone alerts on for ${device.label}` });
      send(res, 200, { device: pushDeviceView(device) });
    },

    'DELETE /api/push/devices/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      const device = push.devicesOf(admin.id).find((d) => d.id === id);
      if (!device || !push.remove(id, admin.id)) throw new HttpError(404, 'No such device');
      record(req, 'settings-changed', { actor: admin.username, detail: `phone alerts off for ${device.label}` });
      send(res, 200, { devices: push.devicesOf(admin.id).map(pushDeviceView) });
    },

    'POST /api/push/test': async (req, res) => {
      const admin = requireAdmin(req);
      const devices = push.devicesOf(admin.id);
      if (!devices.length) throw new HttpError(400, 'Turn on alerts on a device first');
      const result = await push.sendAll(devices, { title: 'Roost alerts are on', body: 'This is a test from Roost.', tag: 'roost-test', url: '/#/admin' }, { ttl: 600 });
      send(res, 200, { result, devices: push.devicesOf(admin.id).map(pushDeviceView) });
    },

    // What's new: every release this person can see, newest first.
    'GET /api/releases': (req, res) => {
      const user = requireUser(req);
      send(res, 200, { current: APP_VERSION, releases: releases.visibleTo(RELEASES, user.role) });
    },

    // Closing the showcase (or opening the page) marks everything up to now as seen.
    'POST /api/me/whats-new/seen': (req, res) => {
      const user = requireUser(req);
      user.seenVersion = APP_VERSION;
      store.save();
      send(res, 200, { user: publicUser(db(), user) });
    },

    'GET /api/alerts': (req, res) => {
      requireAdmin(req);
      send(res, 200, alertView());
    },

    // "Ignore until fixed": the alert stays listed but stops counting on the bell.
    // The Admin → Security checklist, worked out from what Roost already knows.
    'GET /api/admin/security': (req, res) => {
      requireAdmin(req);
      const cert = certSummary();
      send(res, 200, {
        ...securityChecks({
          db: db(),
          entries: activity.entries,
          cert,
          updates: updates.summary(),
          backup: backup.summarize(backup.readStatus(dataDir)),
          pushDevices: db().users.filter((u) => u.role === 'admin').reduce((n, u) => n + push.devicesOf(u.id).length, 0),
          outside: Boolean(cert),
          lockdown: db().settings.lockdown || null,
          ports: db().settings.portCheck || null,
          codeCheck: db().settings.codeCheck || null,
          sentinelMode: sentinel.mode,
          backupTest: (backup.readStatus(dataDir) || {}).verify || null,
        }),
        lockdown: db().settings.lockdown || null,
        checkedAt: new Date().toISOString(),
      });
    },

    // Tries common ports on Roost's public address. Only when asked, at most once a minute.
    'POST /api/admin/security/ports': async (req, res) => {
      const admin = requireAdmin(req);
      const last = db().settings.portCheck;
      if (last && Date.now() - last.at < 60 * 1000) throw new HttpError(429, 'Checked a moment ago. Try again in a minute.');
      let ip;
      try {
        ip = await remote.homeIp();
      } catch (err) {
        throw new HttpError(502, err.message);
      }
      db().settings.portCheck = await checkPorts(ip, portOptions);
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: 'checked which ports are open' });
      send(res, 200, { ports: db().settings.portCheck });
    },

    // Reads Roost's own code for known weak spots (src/code-check.js). Only when asked.
    'POST /api/admin/security/code': (req, res) => {
      const admin = requireAdmin(req);
      db().settings.codeCheck = codeCheck.run(path.join(__dirname, '..'));
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: 'checked Roost\'s code' });
      send(res, 200, { codeCheck: db().settings.codeCheck });
    },

    // ---------- Sentinel ----------

    'GET /api/admin/sentinel': (req, res) => {
      requireAdmin(req);
      send(res, 200, sentinel.view());
    },

    'PUT /api/admin/sentinel': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      if (!SENTINEL_MODES.includes(body.mode)) throw new HttpError(400, 'Choose off, manual or auto');
      if (body.mode !== sentinel.mode) {
        sentinel.setMode(body.mode);
        record(req, 'settings-changed', { actor: admin.username, detail: `Sentinel ${body.mode}` });
        if (body.mode !== 'off') sentinel.checkSeal();
      }
      send(res, 200, sentinel.view());
    },

    // A text file to hand to Claude: how the incident looked, with no secrets.
    'GET /api/admin/sentinel/report': (req, res) => {
      requireAdmin(req);
      const id = new URL(req.url, 'http://roost').searchParams.get('incident');
      const incident = sentinel.incidents.find((i) => i.id === id);
      if (!incident || !incident.evidence) throw new HttpError(404, 'That incident has no report any more');
      const text = buildReport({ incident, entries: activity.entries, users: db().users, settings: db().settings, version: APP_VERSION, mode: sentinel.mode, bans: sentinel.view().bans });
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="roost-incident-${incident.at.slice(0, 10)}-${incident.kind}.md"`, 'Cache-Control': 'no-store' });
      res.end(text);
    },

    'POST /api/admin/sentinel/ban': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const incident = typeof body.incident === 'string' && sentinel.incidents.find((i) => i.id === body.incident);
      const ip = incident ? incident.ip : str(body.ip, 45);
      if (!ip || net.isIP(ip) === 0) throw new HttpError(400, 'That is not an address');
      if (!sentinel.ban(ip, incident ? incident.kind : 'by hand')) throw new HttpError(400, 'That address is on your home network or Cloudflare, so it can’t be banned');
      record(req, 'settings-changed', { actor: admin.username, detail: `Sentinel banned ${ip}` });
      send(res, 200, sentinel.view());
    },

    // "That's mine": accepts a new container, or its new image, as normal.
    'POST /api/admin/sentinel/trust': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const incident = sentinel.incidents.find((i) => i.id === body.incident);
      if (!sentinel.trust(incident)) throw new HttpError(404, 'That is not a container incident');
      record(req, 'settings-changed', { actor: admin.username, detail: `Sentinel trusts container ${incident.target.name}` });
      send(res, 200, sentinel.view());
    },

    // Signs out a sign-in Sentinel thinks was stolen.
    'POST /api/admin/sentinel/end-session': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const incident = sentinel.incidents.find((i) => i.id === body.incident);
      if (!incident || incident.kind !== 'session' || !incident.target) throw new HttpError(404, 'That is not a stolen-sign-in incident');
      sessions.destroyId(incident.target.userId, incident.target.sessionId);
      incident.handled = 'signed out';
      sentinel.saveSoon();
      record(req, 'settings-changed', { actor: admin.username, detail: 'Sentinel: signed out a sign-in that looked stolen' });
      send(res, 200, sentinel.view());
    },

    'POST /api/admin/sentinel/unban': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      if (sentinel.unban(str(body.ip, 45))) record(req, 'settings-changed', { actor: admin.username, detail: `Sentinel unbanned ${str(body.ip, 45)}` });
      send(res, 200, sentinel.view());
    },

    // One tap to shut the door: outside access pauses, every sign-in ends (except
    // this one) and two-step "trusted device" cookies stop counting. Lifting it
    // brings outside access back; people sign in again.
    'POST /api/admin/lockdown': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const on = body.on === true;
      if (on === Boolean(db().settings.lockdown)) return send(res, 200, { lockdown: db().settings.lockdown || null });
      if (on) engageLockdown(admin.username, admin.id, tokenOf(req));
      else delete db().settings.lockdown;
      store.save();
      record(req, on ? 'lockdown-on' : 'lockdown-off', { actor: admin.username });
      send(res, 200, { lockdown: db().settings.lockdown || null });
    },

    'POST /api/alerts/:id/dismiss': (req, res, id) => {
      requireAdmin(req);
      const alert = alertsOf(db()).find((a) => a.id === id && !a.resolvedAt);
      if (!alert) throw new HttpError(404, 'That alert has already cleared');
      alert.dismissedAt = new Date().toISOString();
      store.save();
      send(res, 200, alertView());
    },

    'PUT /api/admin/notice': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const text = str(body.text, 200);
      if (text) {
        db().settings.notice = { text, until: cleanUntil(body.until), at: new Date().toISOString() };
        record(req, 'notice-posted', { actor: admin.username, detail: text });
      } else if (db().settings.notice) {
        delete db().settings.notice;
        record(req, 'notice-cleared', { actor: admin.username });
      }
      store.save();
      send(res, 200, { notice: activeNotice() });
    },

    'GET /api/admin/activity': (req, res) => {
      requireAdmin(req);
      const q = new URL(req.url, 'http://roost').searchParams;
      const before = Number(q.get('before')) || Infinity;
      const filter = FILTERS.includes(q.get('filter')) ? q.get('filter') : '';
      send(res, 200, activity.page({ before, filter, limit: 50 }));
    },

    // ---------- remote access ----------

    // Public on purpose: the check asks for this from outside. It only proves
    // "this is that Roost" and reveals nothing else.
    'GET /api/remote/ping': (req, res) => {
      send(res, 200, { nonce: remote.nonce });
    },

    'GET /api/admin/remote': (req, res) => {
      requireAdmin(req);
      send(res, 200, remote.view());
    },

    'PUT /api/admin/remote': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const before = db().settings.remote || {};
      const next = remoteAccess.clean(body);
      // Turning this on rewrites the domain's live record (orange cloud on), which
      // changes how the domain behaves, so it needs an explicit yes, never a default.
      if (next.ddns && !before.ddns && body.confirmProxy !== true) {
        throw new HttpError(400, 'Confirm that Roost may change the domain’s Cloudflare record');
      }
      db().settings.remote = { ...before, ...next };
      store.save();
      const changes = [];
      if (next.ddns !== Boolean(before.ddns)) changes.push(`keeping the domain pointed home ${next.ddns ? 'on' : 'off'}`);
      if (next.cloudflareOnly !== Boolean(before.cloudflareOnly)) changes.push(`Cloudflare-only traffic ${next.cloudflareOnly ? 'on' : 'off'}`);
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: `Remote access: ${changes.join(', ')}` });
      send(res, 200, remote.view());
    },

    // Updates the record and tests the route from outside; takes a few seconds.
    'POST /api/admin/remote/check': async (req, res) => {
      requireAdmin(req);
      await remote.check();
      send(res, 200, remote.view());
    },

    // ---------- Coffee Galaxy gateway ----------

    'GET /api/admin/coffee': (req, res) => {
      requireAdmin(req);
      send(res, 200, coffeeView());
    },

    'PUT /api/admin/coffee': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const before = db().settings.coffee || {};
      const w = db().settings.wireguard || {};
      const peerPublicKey = str(body.peerPublicKey, 60);
      const endpoint = body.endpoint === undefined || body.endpoint === '' ? '' : wireguard.cleanEndpoint(body.endpoint);
      if (peerPublicKey && !wireguard.validKey(peerPublicKey)) throw new HttpError(400, 'That public key looks wrong; paste the whole line the Oracle script printed');
      if (endpoint === null) throw new HttpError(400, 'The other server\'s address should look like 141.147.108.43 or 141.147.108.43:51820');
      // A blank secret keeps the one already saved; it is never sent back.
      const secret = str(body.secret, 300).toLowerCase() || before.secret || '';
      if (secret && !validSecret(secret)) throw new HttpError(400, 'The shared secret should be at least 64 letters and digits (0-9, a-f); use Make one');
      const enabled = body.enabled === true;
      if (enabled && !secret) throw new HttpError(400, 'Make or paste the shared secret first');
      if (enabled && !(db().settings.tls || {}).domain) throw new HttpError(400, 'Set the domain under Secure connection first');
      db().settings.coffee = { ...before, enabled, secret };
      db().settings.wireguard = { ...w, peerPublicKey: peerPublicKey || w.peerPublicKey || '', endpoint: endpoint || w.endpoint || '' };
      const cfg = db().settings.wireguard;
      if (cfg.peerPublicKey && cfg.endpoint) {
        link.write({ peerPublicKey: cfg.peerPublicKey, endpoint: cfg.endpoint });
        cfg.applied = { ...(await link.apply()), at: Date.now() };
      }
      store.save();
      const changes = [];
      if (enabled !== Boolean(before.enabled)) changes.push(`Coffee Galaxy gateway ${enabled ? 'on' : 'off'}`);
      if (secret !== (before.secret || '')) changes.push('shared secret changed');
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: changes.join(', ') });
      send(res, 200, coffeeView());
    },

    // Makes a new shared secret and shows it once, to paste into Coffee Galaxy's config.
    'POST /api/admin/coffee/secret': (req, res) => {
      const admin = requireAdmin(req);
      const secret = newSecret();
      db().settings.coffee = { ...(db().settings.coffee || {}), secret };
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: 'Coffee Galaxy shared secret made' });
      send(res, 200, { secret, ...coffeeView() });
    },

    'POST /api/admin/coffee/check': async (req, res) => {
      requireAdmin(req);
      const result = await coffee.health(coffeeOptions.fetchImpl);
      db().settings.coffee = { ...(db().settings.coffee || {}), check: result };
      store.saveSoon();
      send(res, 200, coffeeView());
    },

    // ---------- Galaxies (Docker, on this box) ----------

    'GET /api/admin/galaxies': (req, res) => {
      requireAdmin(req);
      send(res, 200, galaxiesView());
    },

    // Adds a galaxy: a name and where its container listens. The shared secret
    // is made here and shown once, inside a ready-to-paste ZimaOS compose file.
    'POST /api/admin/galaxies': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const list = galaxyList();
      if (list.length >= galaxies.MAX) throw new HttpError(400, `Up to ${galaxies.MAX} galaxies`);
      const name = str(body.name, 40);
      if (!name) throw new HttpError(400, 'Give the galaxy a name');
      const id = galaxies.slug(str(body.id, 24) || name);
      if (!id) throw new HttpError(400, 'The name needs 2 to 24 letters, digits or dashes, starting with a letter');
      if (galaxies.RESERVED.has(id) || list.some((g) => g.id === id) || db().apps.some((a) => a.id === galaxies.appId(id))) throw new HttpError(409, 'That name is taken');
      const address = galaxyAddress(body);
      const image = galaxyImage(body);
      const g = { id, name, image, address, enabled: Boolean((db().settings.tls || {}).domain), secret: galaxies.newSecret(), createdAt: Date.now() };
      db().settings.galaxies = [...list, g];
      db().apps = [...db().apps, galaxies.card(g)];
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: `galaxy ${name} added` });
      send(res, 201, { ...galaxiesView(), added: g.id, secret: g.secret, compose: galaxies.compose(g, g.secret) });
    },

    'PUT /api/admin/galaxies/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const g = findGalaxy(id);
      const changes = [];
      if (body.name !== undefined) {
        const name = str(body.name, 40);
        if (!name) throw new HttpError(400, 'Give the galaxy a name');
        if (name !== g.name) changes.push('renamed');
        g.name = name;
        const c = db().apps.find((a) => a.id === galaxies.appId(g.id));
        if (c) c.name = name;
      }
      if (body.address !== undefined || body.port !== undefined) {
        const address = galaxyAddress(body);
        if (address !== g.address) changes.push('address changed');
        g.address = address;
      }
      if (body.image !== undefined) g.image = galaxyImage(body);
      if (body.enabled !== undefined) {
        const enabled = body.enabled === true;
        if (enabled && !(db().settings.tls || {}).domain) throw new HttpError(400, 'Set the domain under Secure connection first');
        if (enabled !== Boolean(g.enabled)) changes.push(enabled ? 'switched on' : 'switched off');
        g.enabled = enabled;
      }
      store.save();
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: `galaxy ${g.name} ${changes.join(', ')}` });
      send(res, 200, galaxiesView());
    },

    'POST /api/admin/galaxies/:id/secret': (req, res, id) => {
      const admin = requireAdmin(req);
      const g = findGalaxy(id);
      g.secret = galaxies.newSecret();
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: `galaxy ${g.name} shared secret made` });
      send(res, 200, { ...galaxiesView(), secret: g.secret, compose: galaxies.compose(g, g.secret) });
    },

    // The same file with a stand-in for the secret, which Roost never shows again.
    'GET /api/admin/galaxies/:id/compose': (req, res, id) => {
      requireAdmin(req);
      send(res, 200, { compose: galaxies.compose(findGalaxy(id)) });
    },

    'POST /api/admin/galaxies/:id/check': async (req, res, id) => {
      requireAdmin(req);
      const g = findGalaxy(id);
      g.check = await galaxyGateway(g).health(coffeeOptions.fetchImpl);
      store.saveSoon();
      send(res, 200, galaxiesView());
    },

    'DELETE /api/admin/galaxies/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      const g = findGalaxy(id);
      db().settings.galaxies = galaxyList().filter((x) => x.id !== g.id);
      const appKey = galaxies.appId(g.id);
      db().apps = db().apps.filter((a) => a.id !== appKey);
      for (const u of db().users) if (Array.isArray(u.apps)) u.apps = u.apps.filter((a) => a !== appKey);
      store.save();
      record(req, 'settings-changed', { actor: admin.username, detail: `galaxy ${g.name} removed` });
      send(res, 200, galaxiesView());
    },

    // ---------- HTTPS certificate ----------

    'GET /api/admin/tls': (req, res) => {
      requireAdmin(req);
      send(res, 200, tlsView(req));
    },

    'PUT /api/admin/tls': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const current = db().settings.tls || {};
      const domain = str(body.domain, 200).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
      if (!validDomain(domain)) throw new HttpError(400, 'Enter the domain on its own, like roostos.network');
      const email = str(body.email, 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
      // A blank token keeps the one already saved; it is never sent back to the browser.
      const token = str(body.token, 200) || current.token || '';
      if (!token) throw new HttpError(400, 'Paste a Cloudflare API token');
      db().settings.tls = { domain, token, email };
      store.save();
      certs.lastError = null;
      // A new token deserves a fresh look, not yesterday's answer.
      if (token !== current.token) { outside.forgetCloudflare(); outside.check(); }
      if (body.renew !== false) certs.renew();
      send(res, 200, tlsView(req));
    },

    'POST /api/admin/tls/renew': (req, res) => {
      requireAdmin(req);
      if (!(db().settings.tls || {}).token) throw new HttpError(400, 'Save a domain and Cloudflare token first');
      certs.renew();
      send(res, 202, tlsView(req));
    },

    'DELETE /api/admin/tls': (req, res) => {
      requireAdmin(req);
      if (certs.busy) throw new HttpError(409, 'Wait for the current certificate request to finish');
      delete db().settings.tls;
      store.save();
      certs.clear();
      outside.forgetCloudflare();
      send(res, 200, tlsView(req));
    },

    // ---------- storage limits ----------

    'GET /api/me/storage': (req, res) => {
      const user = requireUser(req);
      const requests = storage.requestsOf(db()).filter((r) => r.userId === user.id).slice(-5).reverse();
      send(res, 200, { storage: storage.storageOf(db(), user), requests });
    },

    'POST /api/me/storage-requests': async (req, res) => {
      const user = requireUser(req);
      if (user.role === 'admin') throw new HttpError(400, 'Admins set their own limit under Admin → Users');
      if (user.role === 'guest') throw new HttpError(403, 'Not available on a guest pass');
      const body = await readJson(req);
      const requestedGb = storage.parseLimitGb(body.requestedGb);
      if (!requestedGb) throw new HttpError(400, 'Ask for a whole number of GB');
      const current = storage.limitGbOf(db(), user);
      if (current === null || requestedGb <= current) throw new HttpError(400, `Ask for more than your current ${current} GB`);
      const requests = storage.requestsOf(db());
      if (requests.some((r) => r.userId === user.id && r.status === 'pending')) {
        throw new HttpError(409, 'You already have a request waiting for an admin');
      }
      const request = {
        id: store.newId(),
        userId: user.id,
        currentGb: current,
        requestedGb,
        note: str(body.note, 300),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      requests.push(request);
      store.save();
      record(req, 'storage-requested', { actor: user.username, detail: `${gbText(current)} → ${gbText(requestedGb)}` });
      send(res, 201, { request });
    },

    // ---------- Cockerel: Raven's personal agent ----------
    // Only admins, and the VM itself (signed). The chat and feed are the panel;
    // Admin holds the link, limits and Pause.
    'GET /api/cockerel': async (req, res) => {
      requireAdmin(req);
      const c = cockerel.data();
      send(res, 200, {
        enabled: cockerel.enabled(),
        ...cockerel.view(),
        log: c.log.slice(-100),
        jobs: c.jobs.slice(-10).reverse(),
        todayGb: Math.round((cockerel.dayBytes() / COCKEREL_GB) * 10) / 10,
        status: cockerel.enabled() ? await cockerel.status() : null,
      });
    },

    'POST /api/cockerel/chat': async (req, res) => {
      const admin = requireAdmin(req);
      if (cockerel.config().paused) throw new HttpError(409, 'Cockerel is paused. Press Resume first');
      const text = str((await readJson(req)).text, 2000);
      if (!text) throw new HttpError(400, 'Type a message');
      cockerel.add({ kind: 'you', text });
      try {
        const out = await cockerel.call('POST', '/chat', { text, from: admin.username, context: assistant.context(), toolsOff: assistant.settings().toolsOff }, 5 * 60 * 1000);
        const reply = cockerel.add({ kind: 'cockerel', text: str(out.reply, 4000) || 'Done.' });
        send(res, 200, { reply });
      } catch (err) {
        if (!(err instanceof CockerelError)) throw err;
        throw new HttpError(err.status, err.message);
      }
    },

    // Raven's answer to a question Cockerel asked ("find it?" and so on).
    'POST /api/cockerel/answer': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const ask = cockerel.data().log.find((e) => e.id === body.id && e.kind === 'ask');
      if (!ask) throw new HttpError(404, 'That question is gone');
      if (ask.answer) throw new HttpError(409, 'Already answered');
      const choice = str(body.choice, 40);
      if (!ask.options.includes(choice)) throw new HttpError(400, 'Pick one of the answers');
      const jobAsk = /^job-(.+)$/.exec(ask.askId);
      if (jobAsk) {
        // Roost's own question: a repeating job he proposed.
        const job = assistant.job(jobAsk[1]);
        if (job && /^yes/i.test(choice)) { job.approved = true; store.save(); } else if (job) assistant.remove('jobs', job.id);
        ask.answer = choice;
        store.save();
        cockerel.add({ kind: 'you', text: choice });
        return send(res, 200, { ok: true });
      }
      try {
        await cockerel.call('POST', '/answer', { askId: ask.askId, choice });
      } catch (err) {
        if (!(err instanceof CockerelError)) throw err;
        throw new HttpError(err.status, err.message);
      }
      ask.answer = choice;
      store.save();
      cockerel.add({ kind: 'you', text: choice });
      send(res, 200, { ok: true });
    },

    'GET /api/admin/cockerel': (req, res) => {
      requireAdmin(req);
      send(res, 200, { ...cockerel.view(), ...assistant.settings() });
    },

    'PUT /api/admin/cockerel': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const changes = {};
      if (body.url !== undefined) {
        const url = str(body.url, 200);
        if (url && !/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d{2,5})?\/?$/.test(url)) throw new HttpError(400, 'Use the VM\'s home-network address, like http://192.168.4.40:7070');
        changes.url = url.replace(/\/+$/, '');
      }
      if (body.secret !== undefined) {
        const secret = str(body.secret, 200);
        if (secret && secret.length < 24) throw new HttpError(400, 'The shared secret needs at least 24 characters');
        changes.secret = secret;
      }
      for (const [k, max] of [['sizeGb', 500], ['dayGb', 2000]]) {
        if (body[k] === undefined) continue;
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n <= 0 || n > max) throw new HttpError(400, `Limits are between 1 and ${max} GB`);
        changes[k] = Math.round(n * 10) / 10;
      }
      if (body.paused !== undefined) changes.paused = body.paused === true;
      const mine = {};
      for (const k of ['tz', 'briefOn', 'briefTime', 'toolsOff']) if (body[k] !== undefined) mine[k] = k === 'tz' || k === 'briefTime' ? str(body[k], 40) : body[k];
      try { if (Object.keys(mine).length) assistant.saveSettings(mine); } catch (err) {
        if (err instanceof AssistantError) throw new HttpError(err.status, err.message);
        throw err;
      }
      cockerel.save(changes);
      if ('paused' in changes) cockerel.add({ kind: 'note', text: changes.paused ? 'Paused by Raven' : 'Resumed' });
      send(res, 200, { ...cockerel.view(), ...assistant.settings() });
    },

    // His notebook: memories, tasks, reminders and repeating jobs. Raven can
    // see and change all of it.
    'GET /api/cockerel/assistant': (req, res) => {
      requireAdmin(req);
      send(res, 200, assistant.view());
    },
    'POST /api/cockerel/assistant': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      try {
        const kinds = { memory: 'memories', task: 'tasks', reminder: 'reminders', job: 'jobs' };
        const id = str(body.id, 60);
        if (body.op === 'delete') assistant.remove(kinds[body.kind] || '', id);
        else if (body.op === 'done') {
          const t = assistant.data().tasks.find((x) => x.id === id);
          if (!t) throw new HttpError(404, 'No such task');
          t.done = body.done !== false;
          store.save();
        } else if (body.op === 'pause') {
          const j = assistant.job(id);
          if (!j) throw new HttpError(404, 'No such job');
          j.paused = body.paused === true;
          store.save();
        } else if (body.op === 'addTask') assistant.addTask(body.text, body.due);
        else if (body.op === 'remember') assistant.remember(body.text);
        else throw new HttpError(400, 'Unknown change');
      } catch (err) {
        if (err instanceof AssistantError) throw new HttpError(err.status, err.message);
        throw err;
      }
      send(res, 200, assistant.view());
    },

    // From the VM, signed. No session: the signature is the sign-in.
    'POST /api/cockerel/hook': async (req, res) => {
      // Only a request that is signed in form may send a big body (a file for Nest).
      if (!/^\d{9,12}$/.test(String(req.headers['x-roost-ts'] || '')) || !/^[0-9a-f]{64}$/.test(String(req.headers['x-roost-sig'] || ''))) throw new HttpError(401, 'Not signed');
      const raw = await readRaw(req, Math.ceil(COCKEREL_FILE_MAX * 1.4));
      if (!cockerel.verify(req.headers, raw)) throw new HttpError(401, 'Not signed');
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
      // Paused, he can't start anything new, but a download already running can still be filed.
      if (cockerel.config().paused && !['log', 'job', 'refresh', 'ready'].includes(body.type)) throw new HttpError(409, 'Cockerel is paused');
      switch (body.type) {
        case 'log':
          cockerel.add({ kind: 'note', text: str(body.text, 2000) });
          return send(res, 200, { ok: true });
        case 'job':
          return send(res, 200, { job: cockerel.setJob(body) });
        case 'check':
          return send(res, 200, cockerel.check(Number(body.bytes)));
        case 'spend':
          cockerel.spend(Number(body.bytes) || 0);
          return send(res, 200, { ok: true });
        case 'ask': {
          const options = Array.isArray(body.options) && body.options.length ? body.options : ['Yes', 'No'];
          const askId = str(body.askId, 60);
          const text = str(body.text, 1000);
          if (!askId || !text) throw new HttpError(400, 'A question needs an id and text');
          cockerel.add({ kind: 'ask', text, options, askId });
          pushNotify({ title: 'Cockerel asks', body: text.slice(0, 120), tag: `cockerel-${askId}`, url: '/#/cockerel' });
          return send(res, 200, { ok: true });
        }
        case 'library': {
          // Is it on Roostflix already? Matches by title, newest first.
          if (!jellyfin.enabled()) return send(res, 200, { found: [], note: 'Roostflix is not linked' });
          const term = str(body.term, 120);
          if (!term) throw new HttpError(400, 'Say what to look for');
          const out = await jellyfin.call('GET', `/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=10&searchTerm=${encodeURIComponent(term)}`);
          return send(res, 200, { found: ((out && out.Items) || []).map((i) => ({ name: i.Name, year: i.ProductionYear || null, type: i.Type })) });
        }
        case 'file': {
          // A file he made for Raven goes into Raven's Nest, under Cockerel/.
          const owner = db().users.find((u) => u.role === 'admin');
          if (!owner) throw new HttpError(409, 'No admin to send it to');
          const data = Buffer.from(typeof body.data === 'string' ? body.data : '', 'base64');
          if (!data.length || data.length > COCKEREL_FILE_MAX) throw new HttpError(413, 'Files up to 20 MB, and not empty');
          const start = nest.startUpload(owner, { parent: 'root', path: 'Cockerel', name: str(body.name, 120), size: data.length, type: 'text/plain' });
          let saved = start.item;
          for (let offset = 0; !saved && offset < data.length; offset += NEST_CHUNK) {
            const out = await nest.putChunk(owner, start.id, offset, Readable.from(data.subarray(offset, offset + NEST_CHUNK)));
            if (out.done) saved = out.item;
          }
          if (!saved) throw new HttpError(500, 'The file did not finish saving');
          cockerel.add({ kind: 'file', text: `Sent you ${saved.name}`, file: { id: saved.id, name: saved.name, size: data.length } });
          pushNotify({ title: 'Cockerel sent you a file', body: saved.name, tag: `cockerel-file-${saved.id}`, url: '/#/cockerel' });
          return send(res, 200, { ok: true, name: saved.name });
        }
        case 'remember':
          return send(res, 200, { item: assistant.remember(body.text) });
        case 'task':
          return send(res, 200, { item: assistant.addTask(body.text, body.due) });
        case 'remind':
          return send(res, 200, { item: assistant.addReminder(str(body.at, 40), body.text), tz: assistant.tz() });
        case 'schedule': {
          // He proposes, Raven decides: it never runs before a yes.
          const job = assistant.addJob({ text: body.text, every: body.every, time: body.time, day: body.day, tz: body.tz });
          const when = job.schedule.every === 'week' ? `every week on day ${job.schedule.day} at ${job.schedule.time}` : `every day at ${job.schedule.time}`;
          cockerel.add({ kind: 'ask', text: `I'd like to do this ${when}: ${job.text}. Is that OK?`, options: ['Yes, do it', 'No'], askId: `job-${job.id}` });
          pushNotify({ title: 'Cockerel asks', body: `Repeat a job ${when}?`, tag: `cockerel-job-${job.id}`, url: '/#/cockerel' });
          return send(res, 200, { item: job, note: 'Waiting for Raven to approve it.' });
        }
        case 'remove':
          assistant.remove({ memory: 'memories', task: 'tasks', reminder: 'reminders', job: 'jobs' }[body.kind] || '', str(body.id, 60));
          return send(res, 200, { ok: true });
        case 'taskdone': {
          const t = assistant.data().tasks.find((x) => x.id === str(body.id, 60));
          if (!t) throw new HttpError(404, 'No such task');
          t.done = true;
          store.save();
          return send(res, 200, { ok: true });
        }
        case 'list':
          return send(res, 200, { lines: assistant.list({ memory: 'memories', task: 'tasks', reminder: 'reminders', job: 'jobs' }[body.kind] || '') });
        case 'notify': {
          // A short note to Raven's phone, at most 10 a day.
          const c = cockerel.data();
          const day = cockerel.today();
          if (!c.notified || c.notified.day !== day) c.notified = { day, n: 0 };
          if (c.notified.n >= 10) throw new HttpError(429, 'That is enough phone notes for today');
          c.notified.n += 1;
          pushNotify({ title: 'Cockerel', body: str(body.text, 200), tag: `cockerel-n-${Date.now()}`, url: '/#/cockerel' });
          cockerel.add({ kind: 'note', text: `Phone note: ${str(body.text, 200)}` });
          return send(res, 200, { ok: true });
        }
        case 'refresh':
          // After he files a new download in the Roostflix folders.
          if (jellyfin.enabled()) await jellyfin.call('POST', '/Library/Refresh');
          return send(res, 200, { ok: true });
        case 'ready': {
          // Tell whoever asked for it, by name, that it is on Roostflix.
          const who = db().users.find((u) => u.username === str(body.requester, 60));
          if (who) push.notify({ title: 'Now on Roostflix', body: str(body.title, 120), tag: `cockerel-${str(body.jobId, 40)}`, url: `${JELLYFIN_PREFIX}/` }, who.id);
          return send(res, 200, { ok: true });
        }
        default:
          throw new HttpError(400, 'Unknown message');
      }
    },

    // Roostflix "Request a movie": people ask, the admin gets a phone alert and
    // marks it added or dismissed.
    'GET /api/roostflix/requests': (req, res) => {
      const user = requireUser(req);
      if (!canUseJellyfin(user)) throw new HttpError(403, "You don't have access to Roostflix");
      send(res, 200, { requests: movieRequests().filter((r) => r.userId === user.id).slice(-8).reverse().map(({ id, title, status }) => ({ id, title, status })) });
    },

    'POST /api/roostflix/requests': async (req, res) => {
      const user = requireUser(req);
      if (!canUseJellyfin(user)) throw new HttpError(403, "You don't have access to Roostflix");
      const body = await readJson(req);
      const title = str(body.title, 120);
      if (!title) throw new HttpError(400, 'Type the title you want');
      const mine = movieRequests().filter((r) => r.userId === user.id && r.status === 'open');
      if (mine.length >= 5) throw new HttpError(409, 'You already have 5 requests waiting');
      if (mine.some((r) => r.title.toLowerCase() === title.toLowerCase())) throw new HttpError(409, 'You already asked for that one');
      const request = { id: store.newId(), userId: user.id, title, note: str(body.note, 300), status: 'open', createdAt: new Date().toISOString() };
      movieRequests().push(request);
      store.save();
      record(req, 'movie-requested', { actor: user.username, detail: title });
      push.notify({ title: 'Movie request', body: `${user.displayName || user.username} asks for ${title}`, tag: `movie-${request.id}`, url: '/#/admin' });
      send(res, 201, { request: { id: request.id, title, status: 'open' } });
    },

    'GET /api/admin/movie-requests': (req, res) => {
      requireAdmin(req);
      const users = new Map(db().users.map((u) => [u.id, u]));
      const requests = movieRequests().filter((r) => r.status === 'open').map((r) => {
        const u = users.get(r.userId);
        return { ...r, user: u && { username: u.username, displayName: u.displayName } };
      });
      send(res, 200, { requests });
    },

    'POST /api/admin/movie-requests/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const request = movieRequests().find((r) => r.id === id);
      if (!request) throw new HttpError(404, 'No such request');
      if (request.status !== 'open') throw new HttpError(409, `That request was already ${request.status}`);
      const body = await readJson(req);
      if (body.action !== 'added' && body.action !== 'dismiss') throw new HttpError(400, 'Action must be added or dismiss');
      request.status = body.action === 'added' ? 'added' : 'dismissed';
      request.decidedAt = new Date().toISOString();
      store.save();
      if (request.status === 'added') push.notify({ title: 'Now on Roostflix', body: request.title, tag: `movie-${request.id}`, url: `${JELLYFIN_PREFIX}/` }, request.userId);
      send(res, 200, { request });
    },

    'GET /api/admin/storage-requests': (req, res) => {
      requireAdmin(req);
      const users = new Map(db().users.map((u) => [u.id, u]));
      const requests = storage.requestsOf(db())
        .filter((r) => r.status === 'pending')
        .map((r) => {
          const u = users.get(r.userId);
          return { ...r, user: u && { username: u.username, displayName: u.displayName }, storage: u && storage.storageOf(db(), u) };
        });
      send(res, 200, { requests, defaultLimitGb: storage.defaultLimitGb(db()) });
    },

    'POST /api/admin/storage-requests/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const request = storage.requestsOf(db()).find((r) => r.id === id);
      if (!request) throw new HttpError(404, 'No such request');
      if (request.status !== 'pending') throw new HttpError(409, `That request was already ${request.status}`);
      const body = await readJson(req);
      if (body.action === 'approve') {
        const user = db().users.find((u) => u.id === request.userId);
        if (!user) throw new HttpError(404, 'No such user');
        const limitGb = body.limitGb === undefined ? request.requestedGb : cleanLimit(body.limitGb);
        user.limitGb = limitGb;
        request.status = 'approved';
        request.approvedGb = limitGb;
      } else if (body.action === 'decline') {
        request.status = 'declined';
      } else {
        throw new HttpError(400, 'Action must be approve or decline');
      }
      request.decidedAt = new Date().toISOString();
      request.decidedBy = admin.username;
      request.reply = str(body.reply, 300);
      store.save();
      const asker = db().users.find((u) => u.id === request.userId);
      record(req, `storage-${request.status}`, {
        actor: admin.username,
        target: asker && asker.username,
        detail: request.status === 'approved' ? gbText(request.approvedGb) : `asked ${gbText(request.requestedGb)}`,
      });
      send(res, 200, { request });
    },

    // For Nest and Glint: read a user's limit before accepting an upload, and
    // report how much that user is storing in the app.
    'GET /api/storage/users/:id': (req, res, username) => {
      requireApp(req);
      const user = db().users.find((u) => u.username === username);
      if (!user) throw new HttpError(404, 'No such user');
      send(res, 200, { username: user.username, storage: storage.storageOf(db(), user) });
    },

    'PUT /api/storage/users/:id/usage': async (req, res, username) => {
      requireApp(req);
      const user = db().users.find((u) => u.username === username);
      if (!user) throw new HttpError(404, 'No such user');
      const body = await readJson(req);
      if (!storage.STORAGE_APPS.includes(body.app)) throw new HttpError(400, `App must be one of ${storage.STORAGE_APPS.join(', ')}`);
      if (!Number.isSafeInteger(body.bytes) || body.bytes < 0) throw new HttpError(400, 'Bytes must be a whole number');
      user.storageUsage = { ...user.storageUsage, [body.app]: body.bytes };
      store.save();
      send(res, 200, { username: user.username, storage: storage.storageOf(db(), user) });
    },
  };

  function route(method, pathname) {
    const exact = routes[`${method} ${pathname}`];
    if (exact) return [exact];
    const m = pathname.match(/^(\/api\/(?:admin\/users|admin\/apps|admin\/invites|admin\/storage-requests|admin\/movie-requests|admin\/setup|admin\/galaxies|storage\/users|links|me\/devices|birdhouse\/plans|alerts|push\/devices))\/([A-Za-z0-9._-]+)(\/usage|\/reset-link|\/restart|\/secret|\/compose|\/check|\/dismiss)?$/);
    const handler = m && routes[`${method} ${m[1]}/:id${m[3] || ''}`];
    return handler ? [handler, m[2]] : null;
  }

  // What a phone or PC needs to install Roost as an app, named after the server.
  function serveManifest(req, res) {
    const name = db().settings.serverName || 'Roost';
    const body = JSON.stringify({
      id: '/',
      name,
      short_name: name.length > 12 ? 'Roost' : name,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // Jellyfin is only reachable through Roost by people Roost lets in to it.
  function jellyfinAllowed(req) {
    const user = currentUser(req);
    return Boolean(user && jellyfin.enabled() && canUseJellyfin(user));
  }

  function serveJellyfin(req, res, pathname) {
    if (!jellyfinAllowed(req)) {
      if (req.method === 'GET') {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      throw new HttpError(currentUser(req) ? 403 : 401, 'Sign in to Roost first');
    }
    if (pathname === JELLYFIN_PREFIX) {
      res.writeHead(302, { Location: `${JELLYFIN_PREFIX}/` });
      return res.end();
    }
    if (pathname === `${JELLYFIN_PREFIX}/` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(OPENER_HTML);
    }
    jellyfin.proxy(req, res);
  }

  // ---------- Coffee Galaxy ----------

  function coffeeView() {
    const c = db().settings.coffee || {};
    const w = db().settings.wireguard || {};
    return {
      domain: (db().settings.tls || {}).domain || '',
      enabled: Boolean(c.enabled),
      secretSaved: Boolean(c.secret),
      publicKey: link.publicKey(),
      peerPublicKey: w.peerPublicKey || '',
      endpoint: w.endpoint || '',
      address: wireguard.ADDRESS,
      peerAddress: wireguard.PEER_ADDRESS,
      applied: w.applied || null,
      check: c.check || null,
    };
  }

  // ---------- Galaxies ----------

  const galaxyList = () => db().settings.galaxies || [];

  function findGalaxy(id) {
    const g = galaxyList().find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'No such galaxy');
    return g;
  }

  function galaxyAddress(body) {
    const a = galaxies.parseAddress(body.address !== undefined && body.address !== '' ? body.address : body.port);
    if (!a) throw new HttpError(400, `Where it listens should look like ${galaxies.HOST}:8200 or just the port (not 8080, which is Roost)`);
    return `${a.host}:${a.port}`;
  }

  function galaxyImage(body) {
    const image = galaxies.cleanImage(body.image);
    if (image === null) throw new HttpError(400, 'The image name looks wrong (for example ghcr.io/you/books:latest)');
    return image;
  }

  function galaxyGateway(g) {
    return galaxies.gatewayFor(g, () => (db().settings.tls || {}).domain);
  }

  function galaxiesView() {
    const domain = (db().settings.tls || {}).domain || '';
    return { domain, hostName: galaxies.HOST, galaxies: galaxyList().map((g) => galaxies.view(g, domain)) };
  }

  // Whether the gateway behind a galaxy card is answering, asked live and briefly.
  // Null for every other card, which the usual probe handles. The Nova card
  // itself is a menu, so it is simply "online" while there is something in it.
  async function galaxyState(a) {
    if (a.id === 'nova') return novaHasGalaxies() ? 'online' : null;
    const g = galaxyList().find((x) => galaxies.appId(x.id) === a.id && x.enabled && x.secret);
    if (!g) return null;
    const out = await galaxyGateway(g).health(coffeeOptions.fetchImpl, probeTimeoutMs);
    return out.ok ? 'online' : 'offline';
  }

  // Each galaxy's gateway, asked live: Coffee Galaxy plus every Docker galaxy.
  async function novaGalaxies() {
    const list = [];
    if (coffee.enabled()) list.push({ name: coffee.name, gateway: coffee });
    for (const g of galaxyList()) if (g.enabled && g.secret) list.push({ name: g.name, gateway: galaxyGateway(g) });
    return Promise.all(list.map(async ({ name, gateway }) => {
      const r = await gateway.health(coffeeOptions.fetchImpl, probeTimeoutMs);
      return { name, state: r.ok ? 'online' : 'offline', ms: r.ms || 0 };
    }));
  }

  const novaHasGalaxies = () => coffee.enabled() || galaxyList().some((g) => g.enabled && g.secret);

  // The apps a person sees on the dashboard: theirs, plus Nova as the way in
  // when they were given a galaxy but not Nova itself.
  function appsFor(user) {
    const mine = visibleApps(db(), user);
    const nova = db().apps.find((a) => a.id === 'nova');
    return nova && !mine.includes(nova) && mine.some((a) => a.id.startsWith('galaxy-')) ? [...mine, nova] : mine;
  }

  // Cards for the Galaxies page. The Nova card opens that page; Coffee Galaxy is
  // an entry in it (coffeeUrl), and every other galaxy keeps its own card, which
  // the dashboard leaves out (galaxy: true).
  function galaxyOpenUrl(a, user) {
    const domain = (db().settings.tls || {}).domain;
    if (a.id === 'nova') {
      const has = visibleApps(db(), user).some((x) => x.id === 'nova');
      return { ...a, url: a.url || '#/galaxies', coffeeUrl: has && domain && coffee.enabled() ? `https://nova.${domain}/coffee/` : '' };
    }
    const g = galaxyList().find((x) => galaxies.appId(x.id) === a.id);
    if (!g) return a;
    return { ...a, galaxy: true, ...(domain && g.enabled && g.secret ? { openUrl: `https://nova.${domain}/${g.id}/` } : {}) };
  }

  // Is this request for nova.<domain>, with at least one gateway behind it on?
  function novaMatches(req) {
    if (coffee.matches(req)) return true;
    const domain = (db().settings.tls || {}).domain;
    if (!domain || !galaxyList().some((g) => g.enabled && g.secret)) return false;
    return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === `nova.${domain}`;
  }

  // Every request to nova.<domain>: /coffee is Coffee Galaxy, /<name> a Docker
  // galaxy, and everything except a few open paths needs a signed-in Roost
  // person who has the app.
  function serveNova(req, res, pathname, search) {
    const domain = (db().settings.tls || {}).domain;
    const redirect = (to) => {
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      return res.end();
    };
    const live = galaxyList().filter((g) => g.enabled && g.secret);
    if (pathname === '/') {
      if (coffee.enabled()) return redirect(`/coffee/${search}`);
      return live.length ? redirect(`/${live[0].id}/${search}`) : send(res, 404, { error: 'Not found' });
    }
    const first = pathname.split('/')[1];
    if (coffee.enabled() && first === 'coffee') {
      if (pathname === '/coffee') return redirect(`/coffee/${search}`);
      const found = coffee.route(pathname);
      if (!found) throw new HttpError(404, 'Not found');
      return gate(req, res, { gw: coffee, found, appKey: 'nova', label: 'Coffee Galaxy', next: 'coffee', search, domain });
    }
    const g = live.find((x) => x.id === first);
    if (!g) throw new HttpError(404, 'Not found');
    if (pathname === `/${g.id}`) return redirect(`/${g.id}/${search}`);
    const gw = galaxyGateway(g);
    return gate(req, res, { gw, found: gw.route(pathname), appKey: galaxies.appId(g.id), label: g.name, next: g.id, search, domain });
  }

  function gate(req, res, { gw, found, appKey, label, next, search, domain }) {
    const ip = clientIp(req, trustProxy);
    if (found.open) {
      if (found.helper && !gw.helperAllowed(ip)) throw new HttpError(429, 'Too many requests, wait a minute');
      return gw.forward(req, res, { path: found.path, search, identity: null, ip, secure: secure(req) });
    }
    const user = currentUser(req);
    if (!user) {
      if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
        res.writeHead(302, { Location: `https://${domain}/?next=${next}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      throw new HttpError(401, 'Sign in to Roost first');
    }
    if (!visibleApps(db(), user).some((a) => a.id === appKey)) throw new HttpError(403, `You don’t have access to ${label}`);
    const identity = gw.identity(user.username, user.role === 'admin' && !twoStepNeeded(db(), user));
    if (!identity) throw new HttpError(403, `This username can’t be used with ${label}`);
    gw.forward(req, res, { path: found.path, search, identity, ip, secure: secure(req) });
  }

  // Runs first on every request: believes the visitor's real address only when
  // the connection is Cloudflare's, and turns away outside traffic that skipped
  // Cloudflare when the admin asked for that. True means the request is handled.
  function screen(req) {
    const visitor = remote.visitor(req);
    if (visitor) req.roostIp = visitor;
    return remote.blocks(req);
  }

  // Shuts outside access and ends every sign-in except one (the admin pressing
  // the button; Sentinel, acting alone, keeps none).
  function engageLockdown(by, keepUserId = null, keepToken = null) {
    if (db().settings.lockdown) return;
    db().settings.lockdown = { at: new Date().toISOString(), by };
    for (const u of db().users) {
      u.trusted = [];
      sessions.destroyUser(u.id, u.id === keepUserId ? keepToken : null);
    }
    secWatch.raise('sec:lockdown', 'Lockdown is on', `${by} paused outside access and signed everyone out.`);
    store.save();
    if (by === 'Sentinel') activity.add('lockdown-on', { actor: by, ip: '' });
  }

  // Lockdown pauses everything that comes in from outside. The router forwards
  // 443 only, so outside traffic is exactly what arrives over HTTPS; the plain
  // home address keeps working so the admin can always get back in and lift it.
  function lockedOut(req) {
    return Boolean(db().settings.lockdown && req.socket.encrypted);
  }

  // Which app a request counts against on the upload meter.
  function trafficApp(pathname) {
    if (pathname === JELLYFIN_PREFIX || pathname.startsWith(`${JELLYFIN_PREFIX}/`)) return 'jellyfin';
    if (pathname.startsWith('/api/nest/') || pathname.startsWith('/s/')) return 'nest';
    return pathname.startsWith('/api/glint/') ? 'glint' : 'roost';
  }

  async function handle(req, res) {
    if (screen(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Use the Roost address, not the IP');
    }
    if (req.socket.encrypted) {
      const ip = clientIp(req, trustProxy);
      if (sentinel.isBanned(ip)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Blocked');
      }
      const seen = sentinel.trace(ip, req.method, req.url, req.headers['user-agent']);
      if (seen) res.on('finish', () => { seen.status = res.statusCode; });
      sentinel.request(ip, req.url);
    }
    if (lockedOut(req)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '3600' });
      return res.end('Roost is locked down for now.');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Over HTTPS, browsers keep to HTTPS for six months. No includeSubDomains, so
    // other names (Coffee Galaxy, home-only addresses) are untouched.
    if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://roost');
      traffic.track(req, res, trafficApp(pathname), clientIp(req, trustProxy));
      if (novaMatches(req)) {
        serveNova(req, res, pathname, new URL(req.url, 'http://roost').search);
      } else if (pathname === JELLYFIN_PREFIX || pathname.startsWith(`${JELLYFIN_PREFIX}/`)) {
        serveJellyfin(req, res, pathname);
      } else if (pathname.startsWith('/s/')) {
        // Public file links: the one place Nest answers without a sign-in.
        await nest.publicHandle(req, res, pathname, clientIp(req, trustProxy));
      } else if (pathname.startsWith('/api/nest/')) {
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'nest')) throw new HttpError(403, 'You don’t have access to Nest');
        await nest.handle(req, res, spaceOwner(user, searchParams), pathname, searchParams);
      } else if (pathname.startsWith('/api/glint/')) {
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
        await glint.handle(req, res, spaceOwner(user, searchParams), pathname, searchParams);
      } else if (pathname.startsWith('/api/backup/')) {
        // Phone backups are Glint photos in the person's own space, so they need Glint.
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
        await photoBackup.handle(req, res, user, pathname, searchParams);
      } else if (immich.matches(pathname)) {
        await immich.handle(req, res, pathname, searchParams);
      } else if (pathname.startsWith('/api/')) {
        const found = route(req.method, pathname);
        if (!found) throw new HttpError(404, 'Not found');
        await found[0](req, res, found[1]);
      } else if (pathname === '/.well-known/immich' && req.method === 'GET') {
        send(res, 200, { api: { endpoint: '/api' } });
      } else if (pathname === '/manifest.webmanifest' && (req.method === 'GET' || req.method === 'HEAD')) {
        serveManifest(req, res);
      } else if (pathname.startsWith('/releases/img/') && (req.method === 'GET' || req.method === 'HEAD')) {
        // The showcase pictures; the name changes whenever the picture does, so they cache well.
        if (!releaseImages.serve(req, res, pathname.slice('/releases/img'.length), searchParams.get('v'))) send(res, 404, { error: 'Not found' });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        res.setHeader('Content-Security-Policy', APP_CSP);
        if (!assets.serve(req, res, pathname, searchParams.get('v'))) send(res, 404, { error: 'Not found' });
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, status === 500 ? { error: 'Something went wrong' } : { error: err.message, ...(err.code && { code: err.code }) });
    }
  }

  // Live updates from Jellyfin (a WebSocket) pass through on both the HTTP and
  // HTTPS side.
  function onUpgrade(req, socket, head) {
    if (screen(req) || lockedOut(req) || (req.socket.encrypted && sentinel.isBanned(clientIp(req, trustProxy)))) return socket.destroy();
    const { pathname } = new URL(req.url, 'http://roost');
    if (pathname.startsWith(`${JELLYFIN_PREFIX}/`) && jellyfinAllowed(req)) return jellyfin.proxyUpgrade(req, socket, head);
    socket.destroy();
  }

  const server = http.createServer(handle);
  server.on('upgrade', onUpgrade);
  server.certs = certs;
  server.outside = outside;
  server.remote = remote;
  // The HTTPS side shares every route; the certificate is looked up per
  // connection, so a renewal takes effect without a restart.
  // Browsers opening Roost by IP address send no name and get no certificate,
  // which is right: the certificate is only valid for the domain.
  server.createHttpsServer = () => {
    const secureServer = https.createServer({ SNICallback: (name, cb) => cb(null, certs.context) }, handle);
    secureServer.on('upgrade', onUpgrade);
    return secureServer;
  };
  watcher.start(alertIntervalMs);
  sentinel.start();
  server.on('close', () => {
    watcher.stop();
    sentinel.stop();
    certs.stop();
    outside.stop();
    remote.stop();
    clearInterval(sweepTimer);
    clearInterval(uptimeTimer);
    clearInterval(uptimeSaveTimer);
    clearInterval(scheduleTimer);
    clearTimeout(uptimeSoon);
    events.stop();
    uptime.save();
    healthHistory.flush();
    store.flush();
    activity.flush();
    traffic.flush();
    sessions.flush();
    photoBackup.close();
    nest.close();
  });
  server.nest = nest;
  server.glint = glint;
  server.photoBackup = photoBackup;
  server.watcher = watcher;
  server.healthHistory = healthHistory;
  server.sentinel = sentinel;
  server.push = push;
  // Save anything still waiting, e.g. when the container is stopped.
  server.flushAll = () => {
    uptime.save();
    healthHistory.flush();
    store.flush();
    activity.flush();
    traffic.flush();
    sessions.flush();
    sentinel.flush();
  };
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const secureCookies = process.env.SECURE_COOKIES === 'true';
  const appToken = process.env.ROOST_APP_TOKEN || '';
  const disks = parseDisks(process.env.ROOST_DISKS);
  const dockerHost = process.env.DOCKER_HOST || '';
  const roostContainer = process.env.ROOST_CONTAINER || 'roost';
  const nestDir = process.env.NEST_DIR || path.join(dataDir, 'nest');
  const trustProxy = process.env.BEHIND_PROXY === 'true';
  const smartDir = process.env.SMART_DIR || '';
  const httpsPort = Number(process.env.HTTPS_PORT) || 8443;
  const staging = process.env.ROOST_ACME_STAGING === 'true';
  const server = createServer({ dataDir, nestDir, backupDir: process.env.BACKUP_DIR || '', secureCookies, disks, dockerHost, roostContainer, smartDir, appToken, trustProxy, tls: { staging } });
  server.listen(port, () => {
    console.log(`Roost is running on http://localhost:${port} (data in ${dataDir})`);
  });
  server.certs.start();
  server.outside.start();
  server.remote.start();
  server.createHttpsServer().listen(httpsPort, () => {
    console.log(`HTTPS is listening on port ${httpsPort}${server.certs.cert ? '' : ' (no certificate yet; set one up under Admin)'}`);
  });
  // docker stop sends SIGTERM; save what is waiting and exit straight away.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.flushAll();
      process.exit(0);
    });
  }
}

module.exports = { createServer };
