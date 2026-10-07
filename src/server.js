'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./store');
const { hashPassword, verifyPassword, Sessions, RateLimiter, SESSION_TTL_MS } = require('./auth');
const { parseDisks, CpuMeter, serverHealth } = require('./status');
const { listContainers, containersFor } = require('./docker');

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

function createServer({ dataDir, secureCookies = false, probeTimeoutMs = 2500, disks, dockerHost, roostContainer = 'roost' } = {}) {
  const store = new Store(dataDir);
  const sessions = new Sessions();
  const limiter = new RateLimiter();
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
    return user;
  }

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
        throw new HttpError(401, 'Wrong username or password');
      }
      login(res, user);
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
        load: os.loadavg(),
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
      send(res, 200, { users: db().users.map(publicUser) });
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
        password: hashPassword(body.password),
        createdAt: new Date().toISOString(),
      };
      db().users.push(user);
      store.save();
      send(res, 201, { user: publicUser(user) });
    },

    'PATCH /api/admin/users/:id': async (req, res, id) => {
      const admin = requireAdmin(req);
      const user = db().users.find((u) => u.id === id);
      if (!user) throw new HttpError(404, 'No such user');
      const body = await readJson(req);
      if (body.displayName !== undefined) user.displayName = str(body.displayName, 60) || user.username;
      if (body.apps !== undefined) user.apps = cleanAppAccess(body.apps);
      if (body.role !== undefined) {
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (user.id === admin.id && role !== 'admin') throw new HttpError(400, "You can't remove your own admin role");
        user.role = role;
      }
      if (body.password !== undefined) {
        if (!validPassword(body.password)) throw new HttpError(400, 'Password must be at least 8 characters');
        user.password = hashPassword(body.password);
        sessions.destroyUser(user.id);
      }
      store.save();
      send(res, 200, { user: publicUser(user) });
    },

    'DELETE /api/admin/users/:id': (req, res, id) => {
      const admin = requireAdmin(req);
      if (id === admin.id) throw new HttpError(400, "You can't delete yourself");
      const before = db().users.length;
      db().users = db().users.filter((u) => u.id !== id);
      if (db().users.length === before) throw new HttpError(404, 'No such user');
      sessions.destroyUser(id);
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

    'PATCH /api/admin/settings': async (req, res) => {
      requireAdmin(req);
      const body = await readJson(req);
      if (body.serverName !== undefined) db().settings.serverName = str(body.serverName, 40) || 'Roost';
      store.save();
      send(res, 200, { settings: db().settings });
    },
  };

  function route(method, pathname) {
    const exact = routes[`${method} ${pathname}`];
    if (exact) return [exact];
    const m = pathname.match(/^\/api\/admin\/users\/([a-f0-9]+)$/);
    if (m && routes[`${method} /api/admin/users/:id`]) return [routes[`${method} /api/admin/users/:id`], m[1]];
    return null;
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
  const disks = parseDisks(process.env.ROOST_DISKS);
  const dockerHost = process.env.DOCKER_HOST || '';
  const roostContainer = process.env.ROOST_CONTAINER || 'roost';
  createServer({ dataDir, secureCookies, disks, dockerHost, roostContainer }).listen(port, () => {
    console.log(`Roost is running on http://localhost:${port} (data in ${dataDir})`);
  });
}

module.exports = { createServer };
