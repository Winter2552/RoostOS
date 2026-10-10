'use strict';

// Two-step sign-in with authenticator app codes (TOTP, RFC 6238), built on
// Node's own crypto. Works with any authenticator app: Google or Microsoft
// Authenticator, 1Password, Bitwarden, iPhone Passwords and so on.

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const RECOVERY_CODES = 10;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Recovery codes skip letters that are easy to misread (0/O, 1/I/L).
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const n = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Accepts the code for now or one step either side, to allow for a phone
// clock that is a little off. Returns the matching step so the caller can
// refuse the same code twice, or null.
function verifyCode(secret, code, lastStep = -1, now = Date.now()) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== DIGITS) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(given))) return s;
  }
  return null;
}

function otpauthUri(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normaliseRecovery(code)).digest('hex');
}

function normaliseRecovery(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ten one-time codes like "k7pm-x3qa". Roost keeps only their hashes.
function newRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODES; i++) {
    let chars = '';
    for (let j = 0; j < 8; j++) chars += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${chars.slice(0, 4)}-${chars.slice(4)}`);
  }
  return codes;
}

// Uses up a recovery code if it matches one; returns true when it did.
function useRecoveryCode(twoStep, code) {
  if (normaliseRecovery(code).length !== 8) return false;
  const hash = hashCode(code);
  const i = twoStep.recovery.findIndex((h) => crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')));
  if (i === -1) return false;
  twoStep.recovery.splice(i, 1);
  return true;
}

module.exports = {
  STEP_SECONDS,
  base32Encode,
  base32Decode,
  newSecret,
  codeAt,
  currentStep,
  verifyCode,
  otpauthUri,
  hashCode,
  newRecoveryCodes,
  useRecoveryCode,
};
