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

// Movies/[Genre/]Name (Year)/Name (Year).ext
function moviePath(root, name, year, ext, genre = '') {
  const n = cleanName(name);
  if (!n) throw new Error('A film needs a name');
  const label = /^\d{4}$/.test(String(year)) ? `${n} (${year})` : n;
  return path.join(root, 'Movies', genre, label, `${label}${ext}`);
}

// Raven's genre folders are whatever folders already sit in Movies that are not
// a film ("Name (Year)"). A genre Claude names maps onto one of them, or to ''.
const GENRE_ALIASES = { documentary: 'documentaries', animation: 'animated', cartoon: 'animated', 'science fiction': 'sci-fi', scifi: 'sci-fi', 'sci fi': 'sci-fi', thriller: 'crime' };
function genreFolders(root) {
  try {
    return require('fs').readdirSync(path.join(root, 'Movies'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/\(\d{4}\)\s*$/.test(e.name) && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch { return []; }
}
function genreFolder(root, genre) {
  const want = String(genre || '').trim().toLowerCase();
  if (!want) return '';
  const folders = genreFolders(root);
  const hit = (w) => folders.find((f) => f.toLowerCase() === w);
  return hit(want) || (GENRE_ALIASES[want] && hit(GENRE_ALIASES[want])) || '';
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

// A page he may open in his browser: https to a real name, never an address
// on a network (the kill switch blocks those anyway; this says why).
function browseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /\.(local|internal|lan|home|localhost)$/.test(h)) return null;
  return u.href;
}

// What a rendered page says, as plain text.
function pageText(html, max = 15000) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max);
}

// Can this machine create folders and files here? Returns '' when yes, else a
// plain-English reason (the usual cause is the media share being read-only
// for his SMB user on ZimaOS).
function writableProblem(dir) {
  const fs = require('fs');
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return '';
  } catch (err) {
    return `${err.code || 'error'} on ${dir}`;
  }
}

// True when the media share should be mounted but isn't (then /srv/media is an
// empty folder on his own disk, and every write fails with a permissions error).
// Only checked for the usual /srv/media layout, or where MEDIA_MOUNT names it.
function shareMissing(mediaRoot, env = process.env) {
  const mount = String(mediaRoot).startsWith('/srv/media') ? '/srv/media' : (env.MEDIA_MOUNT || '');
  if (!mount) return '';
  return require('child_process').spawnSync('mountpoint', ['-q', mount]).status === 1 ? mount : '';
}

// "3.1 MB/s · 12 min left" for the job card and the VM screen.
function progressText(speed, bytesLeft) {
  const bits = [];
  if (speed > 0) bits.push(`${human(speed)}/s`);
  if (speed > 0 && bytesLeft > 0) {
    const s = bytesLeft / speed;
    bits.push(s < 90 ? 'under a minute left' : s < 5400 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`);
  }
  return bits.join(' · ');
}

// The aria2 flags that keep him from ever seeding: stop at once when done
// (time and ratio), and upload only a trickle while downloading.
const NO_SEED = ['--seed-time=0', '--seed-ratio=0.0', '--max-overall-upload-limit=1K'];

module.exports = { genreFolders, genreFolder, shareMissing, writableProblem, progressText, NO_SEED, browseUrl, pageText, sign, headers, verify, OPEN_HOSTS, hostOpen, sourceKind, VIDEO, cleanName, moviePath, episodePath, jobIdOk, human };
