'use strict';

const crypto = require('crypto');
const fs = require('fs');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Sign-ins (browser sessions and device keys) are saved to sessions.json so a
// restart or update doesn't sign everyone out. Only a hash of each token is
// written, so the file can't be used to sign in.
const APP_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;
// "Last active" only needs to be roughly right, so it's written at most this often.
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const MAX_PER_USER = 30;

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

class Sessions {
  // onEnd(session) runs for every sign-in that ends (sign-out, expiry, cap),
  // so anything tied to it, like a Jellyfin sign-in, can end too.
  constructor(file = null, onEnd = () => {}) {
    this.file = file;
    this.onEnd = onEnd;
    this.map = new Map();
    this.timer = null;
    if (file && fs.existsSync(file)) {
      try {
        const now = Date.now();
        for (const s of JSON.parse(fs.readFileSync(file, 'utf8'))) if (s.expires > now) this.map.set(s.hash, s);
      } catch {
        // A damaged file just means everyone signs in again.
      }
    }
  }

  // kind is 'browser' (cookie) or 'app' (a device key sent as a Bearer token).
  create(userId, { kind = 'browser', name = '' } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const mine = this.list(userId);
    // Keep the list tidy: drop the least recently used beyond the cap.
    for (const old of mine.slice(MAX_PER_USER - 1)) this.end(old);
    this.map.set(tokenHash(token), {
      hash: tokenHash(token),
      id: crypto.randomBytes(6).toString('hex'),
      userId,
      kind,
      name: String(name).slice(0, 60),
      created: now,
      lastSeen: now,
      expires: now + (kind === 'app' ? APP_KEY_TTL_MS : SESSION_TTL_MS),
    });
    this.save();
    return token;
  }

  get(token) {
    const s = token && this.map.get(tokenHash(token));
    if (!s) return null;
    const now = Date.now();
    if (s.expires < now) {
      this.end(s);
      this.save();
      return null;
    }
    if (now - s.lastSeen > TOUCH_EVERY_MS) {
      s.lastSeen = now;
      this.saveSoon();
    }
    return s;
  }

  // Newest activity first.
  list(userId) {
    return [...this.map.values()].filter((s) => s.userId === userId).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  end(s) {
    this.map.delete(s.hash);
    this.onEnd(s);
  }

  destroy(token) {
    const s = token && this.map.get(tokenHash(token));
    if (!s) return;
    this.end(s);
    this.save();
  }

  destroyId(userId, id) {
    const s = this.list(userId).find((x) => x.id === id);
    if (!s) return false;
    this.end(s);
    this.save();
    return true;
  }

  // Signs a user out everywhere, or everywhere except one sign-in.
  destroyUser(userId, keepToken = null) {
    const keep = keepToken && tokenHash(keepToken);
    for (const [hash, s] of this.map) if (s.userId === userId && hash !== keep) this.end(s);
    this.save();
  }

  saveSoon() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.save(), 30 * 1000);
    this.timer.unref();
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.map.values()]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// A short name for a sign-in, like "Safari on iPhone", from the browser's User-Agent.
function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari'
    : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown browser';
}

// Per-IP limiter for sign-in. Only failed attempts count, so a household
// signing in through one address (or one tunnel) isn't locked out by
// ordinary use.
class RateLimiter {
  constructor(max = 10, windowMs = 5 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  recent(key) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  allow(key) {
    return this.recent(key).length < this.max;
  }

  fail(key) {
    this.hits.set(key, [...this.recent(key), Date.now()]);
  }
}

module.exports = { hashPassword, verifyPassword, Sessions, RateLimiter, deviceName, SESSION_TTL_MS, APP_KEY_TTL_MS };
