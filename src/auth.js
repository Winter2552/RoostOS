'use strict';

const crypto = require('crypto');

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

// Sessions are kept in memory: a restart signs everyone out, which is fine
// for a home server and avoids writing tokens to disk.
class Sessions {
  constructor() {
    this.map = new Map();
  }

  create(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.map.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
    return token;
  }

  get(token) {
    const s = token && this.map.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.map.delete(token);
      return null;
    }
    return s;
  }

  destroy(token) {
    this.map.delete(token);
  }

  destroyUser(userId) {
    for (const [token, s] of this.map) if (s.userId === userId) this.map.delete(token);
  }
}

// Simple per-IP limiter for login attempts.
class RateLimiter {
  constructor(max = 10, windowMs = 5 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length <= this.max;
  }
}

module.exports = { hashPassword, verifyPassword, Sessions, RateLimiter, SESSION_TTL_MS };
