'use strict';

// One-time links: invites (a new person picks a username and password) and
// password resets (an existing user picks a new password). Only a hash of each
// link is stored, so a copy of roost.json can't be used to open one.

const crypto = require('crypto');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Drops expired links. Returns true if anything was removed, so the caller
// only writes the file when it changed.
function prune(db, now = Date.now()) {
  const list = db.links || [];
  const kept = list.filter((l) => Date.parse(l.expiresAt) > now);
  db.links = kept;
  return kept.length !== list.length;
}

function create(db, fields, ttlMs) {
  const token = newToken();
  const link = {
    ...fields,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  db.links = db.links || [];
  db.links.push(link);
  return { token, link };
}

function find(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = hashToken(token);
  return (db.links || []).find((l) => l.tokenHash === hash && Date.parse(l.expiresAt) > Date.now()) || null;
}

function remove(db, link) {
  db.links = (db.links || []).filter((l) => l !== link);
}

// What an admin sees in the pending list: never the hash.
function adminView(link) {
  const { tokenHash, ...rest } = link;
  return rest;
}

module.exports = { INVITE_TTL_MS, RESET_TTL_MS, prune, create, find, remove, adminView };
