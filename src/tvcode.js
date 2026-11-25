'use strict';

// Sign in a TV with a code. The TV asks for a short code, someone already
// signed in to Roost approves it on their phone or PC, and the TV collects a
// sign-in. Two secrets, as in the usual device-code flow: the short code
// people type (useless alone) and a long secret only the TV holds. Codes live
// in memory only, last ten minutes and work once.

const crypto = require('crypto');
const { RateLimiter } = require('./auth');

const TTL_MS = 10 * 60 * 1000;
const WAIT_MS = 25 * 1000;
const MAX_PENDING_PER_IP = 3;
// No 0/O, 1/I/L: they get misread on a TV across the room.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// "k7m2 qx9p" or "K7M2-QX9P" both mean K7M2QX9P.
function clean(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function show(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// "Smart TV (Samsung)" and so on from the TV browser's User-Agent.
function tvName(ua = '', fallback = 'Browser') {
  const brand = /Tizen|SMART-TV.*Samsung|Samsung/i.test(ua) ? 'Samsung'
    : /Web0S|webOS|NetCast/i.test(ua) ? 'LG'
    : /Hisense|VIDAA/i.test(ua) ? 'Hisense'
    : /BRAVIA|Sony/i.test(ua) ? 'Sony'
    : /AFT|Fire TV/i.test(ua) ? 'Fire TV'
    : /Android TV|GoogleTV|CrKey/i.test(ua) ? 'Android TV'
    : /PlayStation/i.test(ua) ? 'PlayStation'
    : /Xbox/i.test(ua) ? 'Xbox'
    : /Roku/i.test(ua) ? 'Roku'
    : '';
  if (brand) return /Samsung|LG|Hisense|Sony/.test(brand) ? `${brand} TV` : brand;
  return /SMART-?TV|\bTV\b/i.test(ua) ? 'Smart TV' : fallback;
}

class TvCodes {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byCode = new Map();
    this.bySecret = new Map();
    this.starts = new RateLimiter(10, 10 * 60 * 1000); // new codes per address
    this.wrongByUser = new RateLimiter(5, 5 * 60 * 1000);
    this.wrongByIp = new RateLimiter(10, 5 * 60 * 1000);
  }

  // Dropped when something next looks, so no timer runs while nobody asks.
  sweep() {
    const t = this.now();
    for (const e of this.byCode.values()) if (e.expires < t) this.drop(e);
  }

  drop(e) {
    this.byCode.delete(e.code);
    this.bySecret.delete(e.secret);
    for (const w of e.waiters.splice(0)) w();
  }

  // For the TV. Returns null when this address asked for too many.
  start({ name, ip, outside }) {
    this.sweep();
    if (!this.starts.allow(ip)) return null;
    const mine = [...this.byCode.values()].filter((e) => e.ip === ip);
    // The oldest goes first, so a TV that was reloaded a few times still gets a code.
    while (mine.length >= MAX_PENDING_PER_IP) this.drop(mine.shift());
    this.starts.fail(ip);
    let code;
    do {
      code = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
    } while (this.byCode.has(code));
    const e = { code, secret: crypto.randomBytes(32).toString('hex'), name, ip, outside: Boolean(outside), created: this.now(), expires: this.now() + TTL_MS, state: 'pending', userId: null, waiters: [] };
    this.byCode.set(code, e);
    this.bySecret.set(e.secret, e);
    return { code, display: show(code), secret: e.secret, expiresIn: TTL_MS };
  }

  // For the phone: what the code is, or null. Wrong codes count against the
  // person and their address, so a signed-in account can't be used to guess.
  lookup(raw, { userId, ip }) {
    this.sweep();
    if (!this.wrongByUser.allow(userId) || !this.wrongByIp.allow(ip)) return { limited: true };
    const e = this.byCode.get(clean(raw));
    if (!e || e.state !== 'pending') {
      this.wrongByUser.fail(userId);
      this.wrongByIp.fail(ip);
      return null;
    }
    return { code: e.code, display: show(e.code), name: e.name, outside: e.outside, ago: Math.round((this.now() - e.created) / 1000) };
  }

  // Approve or turn down. False when the code is gone.
  decide(raw, userId, approve, approverJf = null) {
    this.sweep();
    const e = this.byCode.get(clean(raw));
    if (!e || e.state !== 'pending') return null;
    e.state = approve ? 'approved' : 'denied';
    e.userId = approve ? userId : null;
    e.approverJf = approve ? approverJf : null;
    for (const w of e.waiters.splice(0)) w();
    return e;
  }

  // The TV has its sign-in: the code can't be used again.
  finish(secret) {
    const e = this.bySecret.get(String(secret || ''));
    if (e) this.drop(e);
  }

  // For the TV: held open until something happens or WAIT_MS passes, so the
  // TV never has to poll on a timer. An approved sign-in stays until finish()
  // is called for it, so a TV whose connection dropped can ask again.
  wait(secret, waitMs = WAIT_MS) {
    this.sweep();
    const e = this.bySecret.get(String(secret || ''));
    if (!e) return Promise.resolve({ state: 'expired' });
    const settle = () => {
      if (e.state === 'approved') return { state: 'approved', userId: e.userId, name: e.name, approverJf: e.approverJf };
      if (e.state === 'denied') { this.drop(e); return { state: 'denied' }; }
      if (e.expires < this.now()) { this.drop(e); return { state: 'expired' }; }
      return { state: 'pending' };
    };
    const now = settle();
    if (now.state !== 'pending') return Promise.resolve(now);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { const i = e.waiters.indexOf(done); if (i >= 0) e.waiters.splice(i, 1); resolve(settle()); }, waitMs);
      timer.unref();
      const done = () => { clearTimeout(timer); resolve(settle()); };
      e.waiters.push(done);
    });
  }
}

module.exports = { TvCodes, clean, show, tvName, TTL_MS };
