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

// Parses a JSON file's bytes (already size-capped by the caller).
function parseBytes(buf) {
  try {
    return parseSidecar(JSON.parse(buf.toString('utf8')));
  } catch {
    return null;
  }
}

module.exports = { parseSidecar, parseBytes, driveInfoNames, SIDECAR_MAX: 1024 * 1024 };
