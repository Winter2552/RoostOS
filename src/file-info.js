'use strict';

// File info: the details Google keeps beside each file in a Takeout.
//
// Drive writes "<file>-info.json" next to every file (title, dates, owner,
// who it is shared with, Drive id and link). Google Photos writes
// "<file>.json" with the date taken, place, description and people. Roost
// reads these while importing, keeps the useful parts in the Nest database
// (table node_info) and does not show the JSON as a file. Nothing here touches
// a JSON file that doesn't belong to a main file.

const MAX_TEXT = 300;
const MAX_LIST = 50;
const DATE_MIN = Date.UTC(1900, 0, 1);
const DATE_MAX = Date.UTC(2200, 0, 1);

const text = (v, max = MAX_TEXT) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const date = (ms) => (Number.isFinite(ms) && ms >= DATE_MIN && ms < DATE_MAX ? ms : null);
const iso = (v) => (typeof v === 'string' ? date(Date.parse(v)) : null);
const unix = (t) => {
  const s = Number(t && t.timestamp);
  return Number.isFinite(s) && s > 0 ? date(Math.round(s * 1000)) : null;
};
const link = (v, host) => {
  const s = text(v, 500);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith(`.${host}`)) ? s : '';
  } catch {
    return '';
  }
};

// Drops empty values so the stored JSON stays small.
function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === null || v === undefined || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

const person = (p) => compact({ name: text(p.name, 100), email: text(p.email_address || p.value, 150), role: text(p.role, 30), type: text(p.type, 30) });

// A parsed JSON file -> the details worth keeping, or null when it isn't a
// Google sidecar (so a regular JSON file is never mistaken for one).
function parseSidecar(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.drive_id === 'string' && (typeof o.title === 'string' || typeof o.mime_type === 'string')) {
    const perms = Array.isArray(o.permissions) ? o.permissions.filter((p) => p && typeof p === 'object').slice(0, MAX_LIST).map(person) : [];
    const owner = perms.find((p) => p.role === 'owner');
    return compact({
      source: 'drive',
      title: text(o.title),
      created: iso(o.created),
      modified: iso(o.content_last_modified) || iso(o.last_modified_by_any_user),
      starred: o.starred === true,
      owner: owner ? { name: owner.name, email: owner.email } : null,
      shared: perms.filter((p) => p !== owner && (p.name || p.email)),
      mime: text(o.mime_type, 100),
      size: Number.isFinite(Number(o.expected_item_size)) && Number(o.expected_item_size) >= 0 ? Number(o.expected_item_size) : null,
      driveId: text(o.drive_id, 100),
      link: link(o.download_url, 'google.com'),
    });
  }
  if (typeof o.title === 'string' && (o.photoTakenTime || o.creationTime)) {
    const geo = o.geoData && typeof o.geoData === 'object' ? o.geoData : {};
    const lat = Number(geo.latitude);
    const lng = Number(geo.longitude);
    const placed = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const from = o.googlePhotosOrigin && typeof o.googlePhotosOrigin === 'object' ? o.googlePhotosOrigin : {};
    const phone = from.mobileUpload && typeof from.mobileUpload === 'object' ? text(from.mobileUpload.deviceType, 40) : '';
    return compact({
      source: 'photos',
      title: text(o.title),
      taken: unix(o.photoTakenTime),
      created: unix(o.creationTime),
      description: text(o.description, 1000),
      lat: placed ? Math.round(lat * 1e6) / 1e6 : null,
      lng: placed ? Math.round(lng * 1e6) / 1e6 : null,
      people: Array.isArray(o.people) ? o.people.map((p) => text(p && p.name, 100)).filter(Boolean).slice(0, MAX_LIST) : [],
      starred: o.favorited === true,
      origin: phone ? phone.toLowerCase().replace(/_/g, ' ') : '',
      link: link(o.url, 'google.com'),
    });
  }
  return null;
}

// Names a main file's info file can have, lower case: "Report.pdf" has
// "Report.pdf-info.json" (Drive) or "Report.pdf.json". A JSON that doesn't match
// one of these, or isn't shaped like a sidecar, is never touched.
function driveInfoNames(file) {
  return [`${file}-info.json`, `${file}.json`].map((n) => n.toLowerCase());
}

// Google Docs, Sheets and Slides come out of Takeout as Word, Excel and
// PowerPoint files (other Google files as html, pdf, png...), and their info file
// drops the extension: "Budget.xlsx" has "Budget-info.json". A folder's info file
// is "<folder>-info.json" the same way, and Drive comments are "<name>-comments.html".

// "Budget-info.json" -> "Budget" (null for a name that isn't an info file).
function infoStem(name) {
  const m = /^(.+)-info\.json$/i.exec(name);
  return m ? m[1] : null;
}

function commentsStem(name) {
  const m = /^(.+)-comments\.html$/i.exec(name);
  return m ? m[1] : null;
}

// "Budget.xlsx" -> "Budget"; a name with no extension is its own stem.
function stemOf(file) {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

// Which extension Drive's own type points at, if it says (to choose between "Budget.xlsx" and "Budget.pdf").
function convertedHint(mime) {
  if (/document/i.test(mime || '')) return 'docx';
  if (/spreadsheet/i.test(mime || '')) return 'xlsx';
  if (/presentation/i.test(mime || '')) return 'pptx';
  return '';
}

// Of several files that could own an info or comments file: the one Drive's type
// points at, else the only one that has none yet; otherwise none (never guess).
// files: [{ name }]; has(file) says it already has this kind of details.
function chooseMain(files, mime, has = () => false) {
  if (files.length === 1) return files[0];
  const hinted = files.filter((f) => f.name.toLowerCase().endsWith(`.${convertedHint(mime)}`));
  if (hinted.length === 1) return hinted[0];
  const fresh = files.filter((f) => !has(f));
  return fresh.length === 1 ? fresh[0] : null;
}

// ---------- comments ----------

const MAX_COMMENTS = 200;
const MAX_REPLIES = 50;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = (h, max = 2000) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] || m;
  }).trim().slice(0, max);
const field = (h, cls) => {
  const m = new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`, 'i').exec(h);
  return m ? plain(m[1]) : '';
};

// The "<name>-comments.html" Drive writes: comments, who wrote them, the text
// they were about, replies and whether they were resolved. Returns a list, or
// null when the page isn't one (so an ordinary .html file is never swallowed).
function parseComments(html) {
  if (typeof html !== 'string' || !/class="comment"/.test(html)) return null;
  const out = [];
  for (const block of html.split(/<div id="[^"]*" class="comment">/).slice(1, MAX_COMMENTS + 1)) {
    const [head, replies = ''] = block.split('<div class="reply-list">');
    const comment = compact({
      author: field(head, 'user-name'),
      resolved: /class="comment-status">\s*Resolved/i.test(head),
      deleted: /class="comment-deleted"/.test(head),
      date: field(head, 'created-date'),
      about: field(head, 'comment-context-value'),
      text: field(head, 'comment-content'),
      replies: replies.split('<div id="').slice(1, MAX_REPLIES + 1).map((r) => compact({
        author: field(r, 'user-name'),
        action: field(r, 'comment-action'),
        date: field(r, 'created-date'),
        text: field(r, 'comment-content'),
      })).filter((r) => r.text || r.action),
    });
    if (comment.text || comment.replies || comment.about) out.push(comment);
  }
  return out.length ? out : null;
}

// Parses a JSON file's bytes (already size-capped by the caller).
function parseBytes(buf) {
  try {
    return parseSidecar(JSON.parse(buf.toString('utf8')));
  } catch {
    return null;
  }
}

module.exports = { parseSidecar, parseBytes, driveInfoNames, infoStem, commentsStem, stemOf, convertedHint, chooseMain, parseComments, SIDECAR_MAX: 1024 * 1024, COMMENTS_MAX: 2 * 1024 * 1024 };
