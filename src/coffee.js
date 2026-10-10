'use strict';

// The gateway for Coffee Galaxy, which runs on its own server and is reached
// over the private WireGuard link (src/wireguard.js). Roost is the only sign-in:
// on every request to nova.<domain>/coffee it checks the person is signed in,
// has the app, and (for guests) still has a pass, then forwards the request
// with a signed header saying who they are. Coffee Galaxy accepts that header
// only from this server's link address.

const http = require('http');
const crypto = require('crypto');

const PREFIX = '/coffee';
const TARGET = 'http://10.77.0.2:4710';
// Reachable without a Roost sign-in: the Van Reader phone app signs in with its
// own per-person token, and the rest are public by design.
const OPEN = new Set(['/__vanstock/helper', '/__health', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']);
const HELPER = '/__vanstock/helper';
const HELPER_PER_MINUTE = 60;
const SECRET_RE = /^[0-9a-f]{64,256}$/;
const USER_RE = /^[a-z0-9._-]{1,40}$/;

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
// What comes back keeps its length, so big images show progress.
const BACK_HOP = new Set([...HOP].filter((h) => h !== 'content-length'));

class Coffee {
  // The other galaxies (src/galaxies.js) reuse this gateway with their own
  // prefix, a shorter list of open paths and their own name in error messages.
  constructor({ getConfig, getDomain, target = TARGET, now = Date.now, prefix = PREFIX, open = OPEN, name = 'Coffee Galaxy', healthError = '' }) {
    this.healthError = healthError;
    this.prefix = prefix;
    this.openPaths = open;
    this.name = name;
    this.getConfig = getConfig;
    this.getDomain = getDomain;
    this.target = new URL(target);
    this.now = now;
    this.helperHits = new Map();
  }

  config() {
    return this.getConfig() || {};
  }

  enabled() {
    const c = this.config();
    return Boolean(c.enabled && c.secret && this.getDomain());
  }

  host() {
    const domain = this.getDomain();
    return domain ? `nova.${domain}` : '';
  }

  // Is this request for the Coffee Galaxy address (and is the gateway on)?
  matches(req) {
    if (!this.enabled()) return false;
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return host === this.host();
  }

  // "/coffee/chat?x=1" → { open, path: "/chat" }; null for anything outside /coffee.
  route(pathname) {
    if (pathname !== this.prefix && !pathname.startsWith(`${this.prefix}/`)) return null;
    const path = pathname.slice(this.prefix.length) || '/';
    return { path, open: this.openPaths.has(path), helper: path === HELPER && this.openPaths.has(HELPER) };
  }

  // The phone app's endpoint is open, so it gets a plain per-address limit.
  helperAllowed(ip) {
    const minute = Math.floor(this.now() / 60000);
    const hit = this.helperHits.get(ip);
    if (!hit || hit.minute !== minute) {
      if (this.helperHits.size > 5000) this.helperHits.clear();
      this.helperHits.set(ip, { minute, n: 1 });
      return true;
    }
    hit.n += 1;
    return hit.n <= HELPER_PER_MINUTE;
  }

  sign(user, admin, ts) {
    return crypto.createHmac('sha256', this.config().secret).update(`${ts}\n${user}\n${admin}`).digest('hex');
  }

  // Header set for one signed-in person. null when the name can't be sent safely.
  identity(user, admin) {
    const name = String(user || '').toLowerCase();
    if (!USER_RE.test(name)) return null;
    const ts = String(Math.floor(this.now() / 1000));
    const flag = admin ? '1' : '0';
    return { 'x-roost-user': name, 'x-roost-admin': flag, 'x-roost-ts': ts, 'x-roost-sig': this.sign(name, flag, ts) };
  }

  // Passes the request on and streams the answer straight back, so big
  // responses (page images) never sit in memory. `identity` is null for open paths.
  forward(req, res, { path, search, identity, ip, secure }) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      // Anything the browser says about who it is gets dropped; Roost's own sign-in cookies stay here.
      if (HOP.has(key) || key.startsWith('x-roost-') || key === 'x-forwarded-for' || key === 'x-forwarded-proto' || key === 'x-forwarded-host') continue;
      if (key === 'cookie') {
        const rest = String(v).split(';').map((c) => c.trim()).filter((c) => c && !/^roost_/.test(c)).join('; ');
        if (rest) headers.cookie = rest;
        continue;
      }
      headers[key] = v;
    }
    headers['x-forwarded-for'] = ip;
    headers['x-forwarded-proto'] = secure ? 'https' : 'http';
    headers['x-forwarded-host'] = String(req.headers.host || '');
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    if (req.headers['transfer-encoding']) headers['transfer-encoding'] = req.headers['transfer-encoding'];
    Object.assign(headers, identity || {});

    const out = http.request({ host: this.target.hostname, port: this.target.port, method: req.method, path: path + search, headers }, (up) => {
      out.setTimeout(0);
      const back = {};
      for (const [k, v] of Object.entries(up.headers)) if (!BACK_HOP.has(k)) back[k] = v;
      res.writeHead(up.statusCode, back);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    // No answer at all for a while means the link or the server is down.
    out.setTimeout(30000, () => out.destroy(new Error('timeout')));
    out.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`${this.name} is not answering right now.`);
      } else {
        res.destroy();
      }
    });
    res.on('close', () => out.destroy());
    req.pipe(out);
  }

  // Is it answering right now?
  async health(fetchImpl = fetch, timeoutMs = 4000) {
    const started = this.now();
    try {
      const res = await fetchImpl(`${this.target.origin}/__health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? { ok: true, ms: this.now() - started, at: this.now() } : { ok: false, at: this.now(), error: `${this.name} answered ${res.status}` };
    } catch {
      return { ok: false, at: this.now(), error: this.healthError || 'Nothing answered over the link. Check both ends are up and the address/key match' };
    }
  }
}

function validSecret(s) {
  return typeof s === 'string' && SECRET_RE.test(s);
}

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { Coffee, PREFIX, TARGET, OPEN, validSecret, newSecret, HELPER_PER_MINUTE };
