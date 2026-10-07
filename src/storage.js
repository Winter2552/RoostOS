'use strict';

// Per-user storage limits and requests for more space.
//
// Roost stores each user's limit and the usage the storage apps report. Roost
// itself holds no files, so enforcing the limit (refusing an upload that goes
// over) is the job of Nest and Glint, which ask the app API below.

const crypto = require('crypto');

const GB = 1024 ** 3;
const DEFAULT_LIMIT_GB = 50;
const MAX_LIMIT_GB = 100000;
const STORAGE_APPS = ['nest', 'glint'];

// A limit is whole GB, or null for "no limit". Returns undefined when invalid.
function parseLimitGb(v) {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT_GB ? n : undefined;
}

function defaultLimitGb(db) {
  return db.settings.defaultLimitGb === undefined ? DEFAULT_LIMIT_GB : db.settings.defaultLimitGb;
}

// Users made before limits existed have no limitGb yet: admins get no limit,
// everyone else the default.
function limitGbOf(db, user) {
  if (user.limitGb !== undefined) return user.limitGb;
  return user.role === 'admin' ? null : defaultLimitGb(db);
}

function storageOf(db, user) {
  const usage = user.storageUsage || {};
  const usedBytes = Object.values(usage).reduce((a, b) => a + b, 0);
  const limitGb = limitGbOf(db, user);
  return {
    limitGb,
    limitBytes: limitGb === null ? null : limitGb * GB,
    usedBytes,
    usage,
    remainingBytes: limitGb === null ? null : Math.max(0, limitGb * GB - usedBytes),
  };
}

function requestsOf(db) {
  if (!Array.isArray(db.storageRequests)) db.storageRequests = [];
  return db.storageRequests;
}

// Apps authenticate with ROOST_APP_TOKEN as a bearer token. With no token set,
// the app API is switched off.
function appTokenOk(req, token) {
  if (!token) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  GB,
  DEFAULT_LIMIT_GB,
  MAX_LIMIT_GB,
  STORAGE_APPS,
  parseLimitGb,
  defaultLimitGb,
  limitGbOf,
  storageOf,
  requestsOf,
  appTokenOk,
};
