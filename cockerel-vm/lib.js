'use strict';

// Shared by Cockerel's service and his helper tool (both run inside his VM).
// Plain Node, no packages. Pure functions live here so they can be tested.

const crypto = require('crypto');
const path = require('path');

const SKEW_S = 120;

// Same signature Roost uses (src/cockerel.js): HMAC-SHA256 over "<ts>\n<body>".
function sign(secret, ts, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}\n${body}`).digest('hex');
}

function headers(secret, body, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  return { 'content-type': 'application/json', 'x-roost-ts': ts, 'x-roost-sig': sign(secret, ts, body) };
}

function verify(secret, hdrs, body, now = Date.now()) {
  const ts = String(hdrs['x-roost-ts'] || '');
  const sig = String(hdrs['x-roost-sig'] || '');
  if (!secret || !/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > SKEW_S) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(secret, ts, body), 'hex'), Buffer.from(sig, 'hex'));
}

// ---------- where he may download from without asking ----------
// Public domain and openly licensed sources. Anything else needs Raven to say
// he is entitled to it (the request log keeps that answer).
const OPEN_HOSTS = ['archive.org', 'download.blender.org', 'studio.blender.org', 'upload.wikimedia.org'];

function hostOpen(host) {
  const h = String(host || '').toLowerCase();
  return OPEN_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
}

// 'open' for an https link on an open host, 'other' for anything else that is
// a web link or a magnet, 'bad' for what he must never fetch (local addresses,
// plain http, other schemes).
function sourceKind(link) {
  const text = String(link || '').trim();
  if (/^magnet:\?/i.test(text)) return 'other';
  let u;
  try { u = new URL(text); } catch { return 'bad'; }
  if (u.protocol !== 'https:' || u.username || u.password) return 'bad';
  if (!u.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':') || /\.(local|lan|internal)$/i.test(u.hostname)) return 'bad';
  return hostOpen(u.hostname) ? 'open' : 'other';
}

// ---------- Jellyfin naming ----------
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts)$/i;
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function cleanName(name) {
  return String(name || '').replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
}

// Movies/Name (Year)/Name (Year).ext
function moviePath(root, name, year, ext) {
  const n = cleanName(name);
  if (!n) throw new Error('A film needs a name');
  const label = /^\d{4}$/.test(String(year)) ? `${n} (${year})` : n;
  return path.join(root, 'Movies', label, `${label}${ext}`);
}

// Series/Name/Season 01/Name - S01E02.ext, from a file called ...S01E02...
function episodePath(root, show, file) {
  const m = /S(\d{1,2})[ ._-]*E(\d{1,3})/i.exec(file);
  if (!m) return null;
  const n = cleanName(show);
  if (!n) throw new Error('A show needs a name');
  const s = String(Number(m[1])).padStart(2, '0');
  const e = String(Number(m[2])).padStart(2, '0');
  return path.join(root, 'Series', n, `Season ${s}`, `${n} - S${s}E${e}${path.extname(file).toLowerCase()}`);
}

// A job id from outside is a file name too, so keep it plain.
const jobIdOk = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(String(id));

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

module.exports = { sign, headers, verify, OPEN_HOSTS, hostOpen, sourceKind, VIDEO, cleanName, moviePath, episodePath, jobIdOk, human };
