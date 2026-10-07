'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./store');
const { hashPassword, verifyPassword, Sessions, RateLimiter, SESSION_TTL_MS } = require('./auth');
const storage = require('./storage');
const { parseDisks, CpuMeter, serverHealth } = require('./status');
const { listContainers, containersFor } = require('./docker');
const twoStep = require('./twostep');
const { qrSvg } = require('./qr');

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

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

async function readJson(req) {
  // Requiring a JSON content type also blocks plain cross-site form posts.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function validUsername(u) {
  return /^[a-z0-9._-]{2,32}$/.test(u);
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 200;
}

// App links may use {host} so they follow whatever address you opened Roost on.
function validAppUrl(u) {
  if (u === '') return true;
  try {
    const parsed = new URL(u.replace(/\{host\}/g, 'localhost'));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
    createdAt: u.createdAt,
    twoStep: {
      on: Boolean(u.twoStep),
      required,
      // Offer it once after sign-in to people who don't have to use it.
      offer: !u.twoStep && !required && !u.twoStepSkipped,
      recoveryLeft: u.twoStep ? u.twoStep.recovery.length : 0,
    },
  };
}

function visibleApps(db, user) {
  return user.role === 'admin' || !Array.isArray(user.apps)
    ? db.apps
    : db.apps.filter((a) => user.apps.includes(a.id));
}

function requestHost(req) {
  const host = String(req.headers.host || 'localhost');
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

async function probe(url, timeoutMs) {
  return (await timedProbe(url, timeoutMs)).state;
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

function createServer({ dataDir, secureCookies = false, probeTimeoutMs = 2500, disks, dockerHost, roostContainer = 'roost', appToken = '', maxFailedSignIns = 10 } = {}) {
  const store = new Store(dataDir);
  const sessions = new Sessions();
  const limiter = new RateLimiter(maxFailedSignIns);
  // Sign-ins waiting for a code, and authenticator secrets waiting to be
  // confirmed. Both are short-lived, so they stay in memory.
  const pendingCodes = new Map();
  const pendingSetups = new Map();
  const cpu = new CpuMeter();
  // Drives shown on the status page. Without a list, show the system drive and
  // the drive Roost keeps its data on (the same drive is only listed once).
  const diskList = disks && disks.length ? disks : [{ label: 'System', path: '/' }, { label: 'Data', path: dataDir }];
  const db = () => store.db;

  function currentUser(req) {
    const s = sessions.get(parseCookies(req)[COOKIE]);
    return s ? db().users.find((u) => u.id === s.userId) || null : null;
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

  function login(res, user, status = 200, cookies = []) {
    const token = sessions.create(user.id);
    send(res, status, { user: publicUser(db(), user) }, { 'Set-Cookie': [sessionCookie(token, secureCookies), ...cookies] });
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

  function trustDevice(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    user.trusted = (user.trusted || []).filter((t) => t.expires > now).slice(-(MAX_TRUSTED - 1));
    user.trusted.push({ hash: sha256(token), expires: now + TRUST_TTL_MS });
    return trustCookie(token, secureCookies);
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
      if (!app.name) throw new HttpError(400, 'Every app needs a name');
      if (!/^[a-z0-9-]+$/i.test(app.id) || seen.has(app.id)) throw new HttpError(400, 'Bad app id');
      if (!validAppUrl(app.url)) throw new HttpError(400, `${app.name}: link must start with http:// or https://`);
      seen.add(app.id);
      return app;
    });
  }

  function cleanLimit(v) {
    const limit = storage.parseLimitGb(v);
    if (limit === undefined) throw new HttpError(400, `Storage limit must be a whole number of GB from 1 to ${storage.MAX_LIMIT_GB}, or blank for no limit`);
    return limit;
  }

  function settingsView() {
    return { ...db().settings, defaultLimitGb: storage.defaultLimitGb(db()), adminsNeedTwoStep: adminsNeedTwoStep(db()) };
  }

  function adminView(user) {
    return { ...publicUser(db(), user), storage: storage.storageOf(db(), user) };
  }

  function requireApp(req) {
    if (!storage.appTokenOk(req, appToken)) throw new HttpError(401, 'App token missing or wrong');
  }

  function cleanAppAccess(apps) {
    if (apps === null || apps === undefined) return null;
    if (!Array.isArray(apps)) throw new HttpError(400, 'Apps must be a list');
    const ids = new Set(db().apps.map((a) => a.id));
    return apps.filter((id) => ids.has(id));
  }

  const routes = {
    'GET /api/state': (req, res) => {
      const user = currentUser(req);
      send(res, 200, {
        serverName: db().settings.serverName,
        setupRequired: db().users.length === 0,
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
      login(res, user, 201);
    },

    'POST /api/login': async (req, res) => {
      if (!limiter.allow(req.socket.remoteAddress)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      const user = db().users.find((u) => u.username === username);
      if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password)) {
        limiter.fail(req.socket.remoteAddress);
        throw new HttpError(401, 'Wrong username or password');
      }
      if (!user.twoStep || isTrusted(req, user)) return login(res, user);
      forget(pendingCodes);
      const ticket = crypto.randomBytes(24).toString('hex');
      pendingCodes.set(ticket, { userId: user.id, expires: Date.now() + CODE_WAIT_MS, tries: 0 });
      send(res, 200, { twoStep: true, ticket });
    },

    // Second step: a code from the authenticator app, or a recovery code.
    'POST /api/login/code': async (req, res) => {
      if (!limiter.allow(req.socket.remoteAddress)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
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
        limiter.fail(req.socket.remoteAddress);
        pending.tries++;
        if (pending.tries >= CODE_TRIES) {
          pendingCodes.delete(body.ticket);
          throw new HttpError(401, 'Too many wrong codes. Sign in again.');
        }
        throw new HttpError(400, "That code didn't work. Check your app's newest code.");
      }
      pendingCodes.delete(body.ticket);
      const cookies = body.trust === true ? [trustDevice(user)] : [];
      store.save();
      login(res, user, 200, cookies);
    },

    'POST /api/logout': (req, res) => {
      sessions.destroy(parseCookies(req)[COOKIE]);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', secureCookies) });
    },

    'PATCH /api/me': async (req, res) => {
      const user = requireUser(req);
      const body = await readJson(req);
      if (body.displayName !== undefined) user.displayName = str(body.displayName, 60) || user.username;
      if (body.newPassword !== undefined) {
        if (typeof body.currentPassword !== 'string' || !verifyPassword(body.currentPassword, user.password)) {
          throw new HttpError(400, 'Current password is wrong');
        }
        if (!validPassword(body.newPassword)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.newPassword);
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
      send(res, 200, { user: publicUser(db(), user) }, { 'Set-Cookie': trustCookie('', secureCookies) });
    },

    'POST /api/me/two-step/forget-devices': (req, res) => {
      const user = requireUser(req);
      user.trusted = [];
      store.save();
      send(res, 200, twoStepStatus(user), { 'Set-Cookie': trustCookie('', secureCookies) });
    },

    // "Not now" on the offer after sign-in; it stays available in Profile.
    'POST /api/me/two-step/skip': (req, res) => {
      const user = requireUser(req);
      user.twoStepSkipped = true;
      store.save();
      send(res, 200, { user: publicUser(db(), user) });
    },

    'GET /api/apps': (req, res) => {
      const user = requireUser(req);
      send(res, 200, { apps: visibleApps(db(), user) });
    },

    'GET /api/apps/status': async (req, res) => {
      const user = requireUser(req);
      const host = requestHost(req);
      const entries = await Promise.all(
        visibleApps(db(), user).map(async (a) => [
          a.id,
          a.url ? await probe(a.url.replace(/\{host\}/g, host), probeTimeoutMs) : 'unset',
        ]),
      );
      send(res, 200, { status: Object.fromEntries(entries) });
    },

    'GET /api/system': (req, res) => {
      requireUser(req);
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
      });
    },

    'GET /api/status': async (req, res) => {
      const user = requireUser(req);
      const host = requestHost(req);
      const [health, docker, web] = await Promise.all([
        serverHealth({ cpu, disks: diskList }),
        listContainers(dockerHost, probeTimeoutMs),
        Promise.all(visibleApps(db(), user).map((a) =>
          a.url ? timedProbe(a.url.replace(/\{host\}/g, host), probeTimeoutMs) : { state: 'unset' })),
      ]);
      const all = docker.containers || [];
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
        ...visibleApps(db(), user).map((a, i) => ({
          id: a.id,
          name: a.name,
          tagline: a.tagline,
          icon: a.icon,
          web: web[i],
          containers: claim(containersFor(a, all)),
        })),
      ];
      send(res, 200, {
        ...health,
        docker: docker.error ? { ok: false, error: docker.error } : { ok: true },
        apps,
        // Everything else Docker runs, for admins only.
        otherContainers: user.role === 'admin' ? all.filter((c) => !claimed.has(c.id)) : [],
        checkedAt: new Date().toISOString(),
      });
    },

    'GET /api/admin/users': (req, res) => {
      requireAdmin(req);
      send(res, 200, { users: db().users.map(adminView) });
    },

    'POST /api/admin/users': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      if (!validUsername(username)) throw new HttpError(400, 'Username: 2–32 of a–z, 0–9, . _ -');
      if (db().users.some((u) => u.username === username)) throw new HttpError(409, 'That username is taken');
      if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
      const user = {
        id: store.newId(),
        username,
        displayName: str(body.displayName, 60) || username,
        role: body.role === 'admin' ? 'admin' : 'user',
        apps: cleanAppAccess(body.apps),
        limitGb: body.limitGb === undefined ? storage.defaultLimitGb(db()) : cleanLimit(body.limitGb),
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
      store.save();
      send(res, 201, { user: adminView(user) });
    },

    'PATCH /api/admin/users/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const user = db().users.find((u) => u.id === id);
      if (!user) throw new HttpError(404, 'No such user');
      const body = await readJson(req);
      if (body.displayName !== undefined) user.displayName = str(body.displayName, 60) || user.username;
      if (body.apps !== undefined) user.apps = cleanAppAccess(body.apps);
      if (body.limitGb !== undefined) user.limitGb = cleanLimit(body.limitGb);
      if (body.role !== undefined) {
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (user.id === admin.id && role !== 'admin') throw new HttpError(400, "You can't remove your own admin role");
        user.role = role;
      }
      if (body.password !== undefined) {
        if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.password);
        user.trusted = [];
        sessions.destroyUser(user.id);
      }
      // For someone who lost their phone and their recovery codes: they sign
      // in with just their password and set it up again.
      if (body.resetTwoStep === true) {
        delete user.twoStep;
        user.trusted = [];
      }
      store.save();
      send(res, 200, { user: adminView(user) });
    },

    'DELETE /api/admin/users/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      if (id === admin.id) throw new HttpError(400, "You can't delete yourself");
      const before = db().users.length;
      db().users = db().users.filter((u) => u.id !== id);
      if (db().users.length === before) throw new HttpError(404, 'No such user');
      sessions.destroyUser(id);
      db().storageRequests = storage.requestsOf(db()).filter((r) => r.userId !== id);
      store.save();
      send(res, 200, { ok: true });
    },

    'PUT /api/admin/apps': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      db().apps = cleanApps(body.apps);
      const ids = new Set(db().apps.map((a) => a.id));
      for (const u of db().users) if (Array.isArray(u.apps)) u.apps = u.apps.filter((a) => ids.has(a));
      store.save();
      send(res, 200, { apps: db().apps });
    },

    'GET /api/admin/settings': (req, res) => {
      requireAdmin(req);
      send(res, 200, { settings: settingsView() });
    },

    'PATCH /api/admin/settings': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      if (body.serverName !== undefined) db().settings.serverName = str(body.serverName, 40) || 'Roost';
      if (body.defaultLimitGb !== undefined) db().settings.defaultLimitGb = cleanLimit(body.defaultLimitGb);
      if (body.adminsNeedTwoStep !== undefined) db().settings.adminsNeedTwoStep = body.adminsNeedTwoStep !== false;
      store.save();
      send(res, 200, { settings: settingsView() });
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
    const m = pathname.match(/^(\/api\/(?:admin\/users|admin\/storage-requests|storage\/users))\/([a-z0-9._-]+)(\/usage)?$/);
    const handler = m && routes[`${method} ${m[1]}/:id${m[3] || ''}`];
    return handler ? [handler, m[2]] : null;
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const { pathname } = new URL(req.url, 'http://roost');
      if (pathname.startsWith('/api/')) {
        const found = route(req.method, pathname);
        if (!found) throw new HttpError(404, 'Not found');
        await found[0](req, res, found[1]);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, pathname);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  });

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
  createServer({ dataDir, secureCookies, disks, dockerHost, roostContainer, appToken }).listen(port, () => {
    console.log(`Roost is running on http://localhost:${port} (data in ${dataDir})`);
  });
}

module.exports = { createServer };
