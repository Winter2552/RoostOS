'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./store');
const { hashPassword, verifyPassword, Sessions, RateLimiter, SESSION_TTL_MS } = require('./auth');
const storage = require('./storage');
const links = require('./links');
const { parseDisks, CpuMeter, serverHealth } = require('./status');
const { listContainers, containersFor } = require('./docker');
const { ActivityLog, clientIp, FILTERS } = require('./activity');
const { HttpError, send, readJson, str } = require('./http');
const { Nest } = require('./nest');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'roost_session';
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

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    apps: u.apps,
    createdAt: u.createdAt,
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

function createServer({ dataDir, nestDir, secureCookies = false, probeTimeoutMs = 2500, disks, dockerHost, roostContainer = 'roost', appToken = '', trustProxy = false, activitySaveDelayMs } = {}) {
  const store = new Store(dataDir);
  const activity = new ActivityLog(dataDir, { saveDelayMs: activitySaveDelayMs });
  // Nest used to be an outside app with no link; it is built in now.
  const nestApp = store.db.apps.find((a) => a.id === 'nest');
  if (nestApp && !nestApp.url) {
    nestApp.url = '#/nest';
    store.save();
  }
  const sessions = new Sessions();
  const limiter = new RateLimiter();
  const cpu = new CpuMeter();
  // Drives shown on the status page. Without a list, show the system drive and
  // the drive Roost keeps its data on (the same drive is only listed once).
  const diskList = disks && disks.length ? disks : [{ label: 'System', path: '/' }, { label: 'Data', path: dataDir }];
  const db = () => store.db;

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
  nest.syncUsage();
  const sweep = () => nest.sweep().catch((err) => console.error('Nest clean-up failed:', err));
  sweep();
  const sweepTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
  sweepTimer.unref();

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
    return user;
  }

  function record(req, type, fields = {}) {
    activity.add(type, { ...fields, ip: clientIp(req, trustProxy) });
  }

  const gbText = (limit) => (limit === null ? 'no limit' : `${limit} GB`);

  function login(res, user, status = 200) {
    const token = sessions.create(user.id);
    send(res, status, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, secureCookies) });
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

  function adminView(user) {
    return { ...publicUser(user), storage: storage.storageOf(db(), user) };
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

  // Finds a live link or explains why it doesn't work. Only misses count
  // towards the rate limit, so typing a username doesn't lock anyone out.
  function openLink(req, token) {
    const link = links.find(db(), token);
    if (!link) {
      if (!limiter.allow(`link:${req.socket.remoteAddress}`)) throw new HttpError(429, 'Too many attempts, wait a few minutes');
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
    'GET /api/state': (req, res) => {
      const user = currentUser(req);
      send(res, 200, {
        serverName: db().settings.serverName,
        setupRequired: db().users.length === 0,
        user: user ? publicUser(user) : null,
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
      login(res, user, 201);
    },

    'POST /api/login': async (req, res) => {
      if (!limiter.allow(clientIp(req, trustProxy))) throw new HttpError(429, 'Too many attempts, wait a few minutes');
      const body = await readJson(req);
      const username = str(body.username, 32).toLowerCase();
      const user = db().users.find((u) => u.username === username);
      if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.password)) {
        // Only the username typed is kept, never the password.
        record(req, 'sign-in-failed', { target: username || null, detail: user ? 'wrong password' : 'no such user' });
        throw new HttpError(401, 'Wrong username or password');
      }
      record(req, 'sign-in', { actor: user.username });
      login(res, user);
    },

    'POST /api/logout': (req, res) => {
      const user = currentUser(req);
      if (user) record(req, 'sign-out', { actor: user.username });
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
        record(req, 'password-changed', { actor: user.username, target: user.username });
      }
      store.save();
      send(res, 200, { user: publicUser(user) });
    },

    'GET /api/apps': (req, res) => {
      const user = requireUser(req);
      send(res, 200, { apps: visibleApps(db(), user) });
    },

    'GET /api/apps/status': async (req, res) => {
      const user = requireUser(req);
      const host = requestHost(req);
      const entries = await Promise.all(
        visibleApps(db(), user).map(async (a) => [a.id, (await appProbe(a, host, probeTimeoutMs)).state]),
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
        Promise.all(visibleApps(db(), user).map((a) => appProbe(a, host, probeTimeoutMs))),
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
        role: body.role === 'admin' ? 'admin' : 'user',
        apps: cleanAppAccess(body.apps),
        limitGb: body.limitGb === undefined ? storage.defaultLimitGb(db()) : cleanLimit(body.limitGb),
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
      store.save();
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
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (user.id === admin.id && role !== 'admin') throw new HttpError(400, "You can't remove your own admin role");
        if (role !== user.role) changes.push(`role ${user.role} → ${role}`);
        user.role = role;
      }
      if (body.password !== undefined) {
        if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.password);
        sessions.destroyUser(user.id);
        changes.push('password reset');
      }
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
      const role = body.role === 'admin' ? 'admin' : 'user';
      const { token, link } = links.create(db(), {
        id: store.newId(),
        kind: 'invite',
        label: str(body.label, 60),
        role,
        apps: role === 'admin' ? null : cleanAppAccess(body.apps),
        limitGb: body.limitGb === undefined ? storage.defaultLimitGb(db()) : cleanLimit(body.limitGb),
        createdBy: admin.id,
      }, links.INVITE_TTL_MS);
      store.save();
      record(req, 'invite-created', { actor: admin.username, detail: [link.label, role].filter(Boolean).join(', ') });
      send(res, 201, { invite: links.adminView(link), token });
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

    'POST /api/admin/users/:id/reset-link': (req, res, id) => {
      const admin = requireAdmin(req);
      const user = db().users.find((u) => u.id === id);
      if (!user) throw new HttpError(404, 'No such user');
      // Only the newest reset link for a user works.
      db().links = (db().links || []).filter((l) => !(l.kind === 'reset' && l.userId === id));
      const { token, link } = links.create(db(), { id: store.newId(), kind: 'reset', userId: id, createdBy: admin.id }, links.RESET_TTL_MS);
      store.save();
      record(req, 'reset-link-created', { actor: admin.username, target: user.username });
      send(res, 201, { expiresAt: link.expiresAt, token });
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
        return login(res, user);
      }
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
      db().users.push(user);
      links.remove(db(), link);
      store.save();
      const inviter = db().users.find((u) => u.id === link.createdBy);
      record(req, 'user-joined', { actor: user.username, detail: inviter ? `invited by ${inviter.username}` : 'invite link' });
      login(res, user, 201);
    },

    'PUT /api/admin/apps': async (req, res) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const before = new Map(db().apps.map((a) => [a.id, a]));
      db().apps = cleanApps(body.apps);
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
      send(res, 200, { apps: db().apps });
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
      store.save();
      if (changes.length) record(req, 'settings-changed', { actor: admin.username, detail: changes.join(', ') });
      send(res, 200, { settings: { ...db().settings, defaultLimitGb: storage.defaultLimitGb(db()) } });
    },

    'GET /api/admin/activity': (req, res) => {
      requireAdmin(req);
      const q = new URL(req.url, 'http://roost').searchParams;
      const before = Number(q.get('before')) || Infinity;
      const filter = FILTERS.includes(q.get('filter')) ? q.get('filter') : '';
      send(res, 200, activity.page({ before, filter, limit: 50 }));
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
    const m = pathname.match(/^(\/api\/(?:admin\/users|admin\/invites|admin\/storage-requests|storage\/users|links))\/([A-Za-z0-9._-]+)(\/usage|\/reset-link)?$/);
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
      if (pathname.startsWith('/api/nest/')) {
        const user = requireUser(req);
        if (!visibleApps(db(), user).some((a) => a.id === 'nest')) throw new HttpError(403, 'You don’t have access to Nest');
        await nest.handle(req, res, user, pathname, new URL(req.url, 'http://roost').searchParams);
      } else if (pathname.startsWith('/api/')) {
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

  server.on('close', () => {
    clearInterval(sweepTimer);
    store.flush();
    activity.flush();
    nest.close();
  });
  server.nest = nest;
  // Save anything still waiting, e.g. when the container is stopped.
  server.flushAll = () => {
    store.flush();
    activity.flush();
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
  const server = createServer({ dataDir, nestDir, secureCookies, disks, dockerHost, roostContainer, appToken, trustProxy });
  server.listen(port, () => {
    console.log(`Roost is running on http://localhost:${port} (data in ${dataDir})`);
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
