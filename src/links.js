'use strict';

// One-time links: invites (a new person picks a username and password) and
// password resets (an existing user picks a new password). Links carry a short
// code like K7PX-2QM9: 8 characters from 31 that can't be mistaken for each
// other (no 0/O, 1/I/L), so it can be read out or typed. That is nearly a
// trillion codes; with the per-address limit on wrong guesses and a 7-day life,
// guessing a live one isn't practical. Codes are stored hashed.

const crypto = require('crypto');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 24 * 60 * 60 * 1000;

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

function hashToken(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

// Accepts any case, with or without the dash or spaces.
function normalize(input) {
  const code = String(input).toUpperCase().replace(/[\s-]/g, '');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

// Shown and linked as K7PX-2QM9.
function format(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
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
  let token;
  do token = newCode(); while ((db.links || []).some((l) => l.tokenHash === hashToken(token)));
  const link = {
    ...fields,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  db.links = db.links || [];
  db.links.push(link);
  return { token: format(token), link };
}

function find(db, token) {
  const code = normalize(token);
  if (!code) return null;
  const hash = hashToken(code);
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
