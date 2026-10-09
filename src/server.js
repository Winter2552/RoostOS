'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./store');
const { hashPassword, verifyPassword, Sessions, RateLimiter, deviceName, SESSION_TTL_MS } = require('./auth');
const storage = require('./storage');
const links = require('./links');
const mail = require('./mail');
const setup = require('./setup');
const backup = require('./backup');
const { parseDisks, readDisks, CpuMeter, serverHealth } = require('./status');
const { listContainers, containersFor, restartContainer } = require('./docker');
const { DriveHealth } = require('./smart');
const { OutsideServices } = require('./outside');
const templates = require('./templates');
const { cleanSchedule, isDue } = require('./schedule');
const { CertManager, validDomain } = require('./tls');
const twoStep = require('./twostep');
const { qrSvg } = require('./qr');
const { ActivityLog, clientIp, FILTERS } = require('./activity');
const { HttpError, send, readJson, str } = require('./http');
const { Nest, disposition } = require('./nest');
const zip = require('./zip');
const restore = require('./restore');
const { Glint } = require('./glint');
const { Assets } = require('./assets');
const { TrafficMeter } = require('./traffic');
const { createSearch, nestSource } = require('./search');
const { Jellyfin, PREFIX: JELLYFIN_PREFIX, OPENER_HTML } = require('./jellyfin');
const { UptimeLog, watchDockerEvents } = require('./uptime');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'roost_session';
// Remembers a device that passed two-step sign-in, so it isn't asked again for 30 days.
const TRUST_COOKIE = 'roost_trust';
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, secure) {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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

function visibleApps(db, user) {
  return user.role === 'admin' || !Array.isArray(user.apps)
    ? db.apps
    : db.apps.filter((a) => user.apps.includes(a.id));
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

function createServer({ dataDir, nestDir, backupDir = '', secureCookies = false, probeTimeoutMs = 2500, disks, dockerHost, roostContainer = 'roost', smartDir = '', appToken = '', trustProxy = false, tls: tlsOptions = {}, outsideOptions = {}, activitySaveDelayMs, sendMail = mail.send, maxFailedSignIns = 10, uptimeCheckMs = 5 * 60 * 1000, scheduleCheckMs = 20 * 1000 } = {}) {
  const store = new Store(dataDir);
  const certs = new CertManager({ dataDir, getConfig: () => store.db.settings.tls, ...tlsOptions });
  // The few outside services Roost leans on, for the admin's status page.
  const outside = new OutsideServices({ tokenOf: () => (store.db.settings.tls || {}).token || '', ...outsideOptions });
  const activity = new ActivityLog(dataDir, { saveDelayMs: activitySaveDelayMs });
  const traffic = new TrafficMeter(dataDir);
  const assets = new Assets(PUBLIC_DIR);
  // Nest and Glint used to be outside apps with no link; they are built in now.
  let linked = false;
  for (const [id, url] of [['nest', '#/nest'], ['glint', '#/glint']]) {
    const app = store.db.apps.find((a) => a.id === id);
    if (app && !app.url) {
      app.url = url;
      linked = true;
    }
  }
  if (linked) store.save();
  const jellyfin = new Jellyfin(() => store.db.settings.jellyfin);
  // Jellyfin sign-ins still being made for a Roost sign-in, by its id.
  const jellyfinLinks = new Map();
  const sessions = new Sessions(path.join(dataDir, 'sessions.json'), (s) => {
    if (s.jf) jellyfin.logout(s.jf.token).catch(() => {});
  });
  const limiter = new RateLimiter(maxFailedSignIns);
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
  // SMART readings the roost-smart helper leaves behind; null when it isn't set up.
  const driveHealth = new DriveHealth(smartDir);

  const nest = new Nest({
    dir: nestDir || path.join(dataDir, 'nest'),
    dbFile: path.join(dataDir, 'nest.db'),
    users: (id) => db().users.find((u) => u.id === id) || null,
    limitOf: (user) => {
      const s = storage.storageOf(db(), user);
      return { limitBytes: s.limitBytes, otherBytes: s.usedBytes - (s.usage.nest || 0) };
    },
    onUsage: (user, bytes) => {
      user.storageUsage = { ...user.storageUsage, nest: bytes };
      store.saveSoon();
    },
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
  const search = createSearch({ sources: [nestSource(nest)], visibleApps: (user) => visibleApps(db(), user) });
  const sweep = () => nest.sweep().then(() => glint.sweep()).catch((err) => console.error('Nest clean-up failed:', err));
  sweep();
  const sweepTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
  sweepTimer.unref();
  // Browsers send the session cookie; phone apps send their device key as a
  // Bearer token.
  function tokenOf(req) {
    const auth = String(req.headers.authorization || '');
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : parseCookies(req)[COOKIE];
  }

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
      // Built-in apps are part of Roost; Roost's own row covers them.
      if (!a.url || builtIn(a.url)) return;
      tracked.push(a.id);
      if (!web || (a.url.includes('{host}') && !uptime.host)) return;
      const r = await timedProbe(a.url.replace(/\{host\}/g, uptime.host), probeTimeoutMs);
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
  const scheduleTimer = setInterval(runSchedules, scheduleCheckMs);
  scheduleTimer.unref();

  function currentUser(req) {
    const s = sessions.get(tokenOf(req));
    const user = s ? db().users.find((u) => u.id === s.userId) || null : null;
    if (user && guestEnded(user)) {
      sessions.destroyUser(user.id);
      return null;
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
  }

  const gbText = (limit) => (limit === null ? 'no limit' : `${limit} GB`);

  // Cookies are marked Secure whenever this request came over HTTPS.
  const secure = (req) => secureCookies || isSecure(req, trustProxy);

  // A sign-in that names a device (an app on a phone) gets a long-lived device
  // key in the reply instead of a cookie.
  function login(req, res, user, { status = 200, cookies = [], device = '', password = null } = {}) {
    if (guestEnded(user)) throw new HttpError(403, 'Your guest pass has ended. Ask whoever invited you for more time.');
    if (device) {
      const key = sessions.create(user.id, { kind: 'app', name: device });
      return send(res, status, { user: publicUser(db(), user), key });
    }
    const token = sessions.create(user.id, { name: deviceName(req.headers['user-agent']) });
    if (password !== null) linkJellyfin(sessions.get(token), user, password);
    send(res, status, { user: publicUser(db(), user) }, { 'Set-Cookie': [sessionCookie(token, secure(req)), ...cookies] });
  }

  // ---------- Jellyfin ----------

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
    return jellyfin.ensureAccount(user.username, password).catch((err) => { jellyfinFailed(err); return null; });
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

  function jellyfinAccessChanged(user) {
    if (!jellyfin.enabled()) return;
    if (canUseJellyfin(user)) {
      jellyfin.enable(user.username).catch(jellyfinFailed);
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
    if (!c || !c.url) return { url: '', keySaved: false, connected: false };
    try {
      return { url: c.url, keySaved: Boolean(c.apiKey), connected: true, ...(await jellyfin.check()) };
    } catch (err) {
      return { url: c.url, keySaved: Boolean(c.apiKey), connected: false, error: err.status === 401 ? 'the API key was refused' : err.message };
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
      if (!app.name) throw new HttpError(400, 'Every app needs a name');
      if (!/^[a-z0-9-]+$/i.test(app.id) || seen.has(app.id)) throw new HttpError(400, 'Bad app id');
      if (!validAppUrl(app.url)) throw new HttpError(400, `${app.name}: link must start with http:// or https://`);
      seen.add(app.id);
      return app;
    });
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

  // Settings for the admin page. The mail password never leaves the server.
  function settingsView() {
    const { mail: _mail, jellyfin: _jellyfin, ...rest } = db().settings;
    return { ...rest, backup: backup.config(rest.backup), publicUrl: rest.publicUrl || '', defaultLimitGb: storage.defaultLimitGb(db()), mail: mailView(), mailEnabled: mailReady(), adminsNeedTwoStep: adminsNeedTwoStep(db()) };
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

  async function deliver(to, subject, text) {
    const m = mailSettings();
    await sendMail(m, { from: m.from, fromName: db().settings.serverName, to, subject, text });
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
    ].join('\n')];
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
    ].join('\n')];
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
      const user = db().users.find((u) => u.username === username);
      if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password)) {
        limiter.fail(clientIp(req, trustProxy));
        // Only the username typed is kept, never the password.
        record(req, 'sign-in-failed', { target: username || null, detail: user ? 'wrong password' : 'no such user' });
        throw new HttpError(401, 'Wrong username or password');
      }
      const device = str(body.device, 60);
      if (guestEnded(user)) record(req, 'sign-in-failed', { target: user.username, detail: 'guest pass ended' });
      if (!user.twoStep || isTrusted(req, user)) {
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
        record(req, 'sign-in-failed', { target: user.username, detail: 'wrong two-step code' });
        pending.tries++;
        if (pending.tries >= CODE_TRIES) {
          pendingCodes.delete(body.ticket);
          throw new HttpError(401, 'Too many wrong codes. Sign in again.');
        }
        throw new HttpError(400, "That code didn't work. Check your app's newest code.");
      }
      pendingCodes.delete(body.ticket);
      record(req, 'sign-in', { actor: user.username, detail: /^\d/.test(code) ? 'with code' : 'with recovery code' });
      const cookies = body.trust === true && !pending.device ? [trustDevice(req, user)] : [];
      store.save();
      login(req, res, user, { cookies, device: pending.device, password: pending.password });
    },

    'POST /api/logout': (req, res) => {
      const user = currentUser(req);
      if (user) record(req, 'sign-out', { actor: user.username });
      sessions.destroy(tokenOf(req));
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', secure(req)) });
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
      const apps = visibleApps(db(), user).map((a) => (a.id === 'jellyfin' && jellyfin.enabled() ? { ...a, openUrl: `${JELLYFIN_PREFIX}/` } : a));
      send(res, 200, { apps, searchable: search.apps(user) });
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
        visibleApps(db(), user).map(async (a) => [a.id, (await appProbe(a, host, probeTimeoutMs)).state]),
      );
      send(res, 200, { status: Object.fromEntries(entries) });
    },

    'GET /api/system': (req, res) => {
      requireMember(req);
      let disk = null;
      try {
        const s = fs.statfsSync(dataDir);
        disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
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
        Promise.all(visibleApps(db(), user).map((a) => appProbe(a, host, probeTimeoutMs))),
      ]);
      const all = docker.containers || [];
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
            name: a.name,
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
      if (body.apps !== undefined || body.role !== undefined) jellyfinAccessChanged(user);
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
      store.save();
      record(req, 'user-removed', { actor: admin.username, target: gone.username });
      send(res, 200, { ok: true });
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
        dockerOk: !docker.error,
        restartable: docker.restartable || [],
        secureCookies,
        trustProxy,
        awayBytes: Object.values(traffic.summary().apps).reduce((n, a) => n + a.week, 0),
        tls: certs.status(),
        ticked: db().settings.setupTicked || [],
        backup: backup.readStatus(dataDir),
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
        await deliver(to, `Test email from ${db().settings.serverName}`, `This is a test from ${db().settings.serverName}. Email is working.`);
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
      const apps = link.role === 'admin' || !Array.isArray(link.apps) ? db().apps : db().apps.filter((a) => link.apps.includes(a.id));
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
      if (body.mail !== undefined) {
        db().settings.mail = cleanMail(body.mail, mailSettings());
        changes.push(`email ${db().settings.mail ? `via ${db().settings.mail.host}` : 'turned off'}`);
      }
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
      send(res, 200, { settings: settingsView() });
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
    const m = pathname.match(/^(\/api\/(?:admin\/users|admin\/apps|admin\/invites|admin\/storage-requests|admin\/setup|storage\/users|links|me\/devices))\/([A-Za-z0-9._-]+)(\/usage|\/reset-link|\/restart)?$/);
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

  // Which app a request counts against on the upload meter.
  function trafficApp(pathname) {
    if (pathname === JELLYFIN_PREFIX || pathname.startsWith(`${JELLYFIN_PREFIX}/`)) return 'jellyfin';
    if (pathname.startsWith('/api/nest/')) return 'nest';
    return pathname.startsWith('/api/glint/') ? 'glint' : 'roost';
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://roost');
      traffic.track(req, res, trafficApp(pathname), clientIp(req, trustProxy));
      if (pathname === JELLYFIN_PREFIX || pathname.startsWith(`${JELLYFIN_PREFIX}/`)) {
        serveJellyfin(req, res, pathname);
      } else if (pathname.startsWith('/api/nest/')) {
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'nest')) throw new HttpError(403, 'You don’t have access to Nest');
        await nest.handle(req, res, user, pathname, searchParams);
      } else if (pathname.startsWith('/api/glint/')) {
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'glint')) throw new HttpError(403, 'You don’t have access to Glint');
        await glint.handle(req, res, user, pathname, searchParams);
      } else if (pathname.startsWith('/api/')) {
        const found = route(req.method, pathname);
        if (!found) throw new HttpError(404, 'Not found');
        await found[0](req, res, found[1]);
      } else if (pathname === '/manifest.webmanifest' && (req.method === 'GET' || req.method === 'HEAD')) {
        serveManifest(req, res);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
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
    const { pathname } = new URL(req.url, 'http://roost');
    if (pathname.startsWith(`${JELLYFIN_PREFIX}/`) && jellyfinAllowed(req)) return jellyfin.proxyUpgrade(req, socket, head);
    socket.destroy();
  }

  const server = http.createServer(handle);
  server.on('upgrade', onUpgrade);
  server.certs = certs;
  server.outside = outside;
  // The HTTPS side shares every route; the certificate is looked up per
  // connection, so a renewal takes effect without a restart.
  // Browsers opening Roost by IP address send no name and get no certificate,
  // which is right: the certificate is only valid for the domain.
  server.createHttpsServer = () => {
    const secureServer = https.createServer({ SNICallback: (name, cb) => cb(null, certs.context) }, handle);
    secureServer.on('upgrade', onUpgrade);
    return secureServer;
  };
  server.on('close', () => {
    certs.stop();
    outside.stop();
    clearInterval(sweepTimer);
    clearInterval(uptimeTimer);
    clearInterval(uptimeSaveTimer);
    clearInterval(scheduleTimer);
    clearTimeout(uptimeSoon);
    events.stop();
    uptime.save();
    store.flush();
    activity.flush();
    traffic.flush();
    sessions.flush();
    nest.close();
  });
  server.nest = nest;
  server.glint = glint;
  // Save anything still waiting, e.g. when the container is stopped.
  server.flushAll = () => {
    uptime.save();
    store.flush();
    activity.flush();
    traffic.flush();
    sessions.flush();
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
