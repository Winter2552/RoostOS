'use strict';

// "What's new": one JSON file per version in releases/ (0.1.json, 0.1.1.json),
// each with a title, a short summary and a few items that have a picture.
// releases/next.json collects items for the release being built; it is never
// shown. Read once at start, since the files ship with the code.
//
// A version looks like 0.1 or 0.1.1. Parts compare as numbers, so 0.1.10 comes
// after 0.1.9.

const fs = require('fs');
const path = require('path');

const VERSION = /^\d+\.\d+(\.\d+)?$/;
const MAX_IMAGE_BYTES = 150 * 1024;

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// What is wrong with one release file (empty when fine). Used by load() and the test.
function problems(rel, dir, { draft = false } = {}) {
  const out = [];
  if (!draft && !VERSION.test(String(rel.version))) out.push('version must look like 0.1 or 0.1.1');
  if (!draft && !/^\d{4}-\d{2}-\d{2}$/.test(String(rel.date))) out.push('date must look like 2026-10-16');
  if (!draft && !rel.title) out.push('title is missing');
  if (!Array.isArray(rel.items) || (!draft && !rel.items.length)) out.push('items are missing');
  for (const [i, item] of (Array.isArray(rel.items) ? rel.items : []).entries()) {
    const at = `item ${i + 1}`;
    if (!item.title) out.push(`${at}: title is missing`);
    if (!item.text) out.push(`${at}: text is missing`);
    if (!item.image) out.push(`${at}: image is missing`);
    else if (!/^[\w.-]+\.(png|jpg|webp)$/.test(item.image)) out.push(`${at}: image must be a plain file name in releases/img`);
    else {
      let size = -1;
      try { size = fs.statSync(path.join(dir, 'img', item.image)).size; } catch { /* reported below */ }
      if (size < 0) out.push(`${at}: releases/img/${item.image} does not exist`);
      else if (size > MAX_IMAGE_BYTES) out.push(`${at}: releases/img/${item.image} is over ${MAX_IMAGE_BYTES / 1024} KB; resize it`);
    }
  }
  return out;
}

// Newest first. A broken file is skipped (and logged) rather than stopping Roost.
function load(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const list = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'next.json') continue;
    try {
      const rel = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const bad = problems(rel, dir);
      if (bad.length) { console.error(`releases/${name}: ${bad.join('; ')}`); continue; }
      list.push(rel);
    } catch (err) {
      console.error(`releases/${name}: ${err.message}`);
    }
  }
  return list.sort((a, b) => compareVersions(b.version, a.version));
}

// The release as one person sees it: admin-only items dropped, and null if nothing is left.
function viewFor(rel, role) {
  const items = rel.items.filter((i) => !i.admin || role === 'admin');
  return items.length ? { version: rel.version, date: rel.date, title: rel.title, summary: rel.summary || '', items: items.map((i) => ({ title: i.title, text: i.text, image: i.image })) } : null;
}

function visibleTo(releases, role) {
  return releases.map((r) => viewFor(r, role)).filter(Boolean);
}

// Versions this person has not seen. Someone who has never closed the showcase
// only gets releases from the day their account was made on, so a new person
// is not shown old news.
function unseenFor(releases, user) {
  const seen = user.seenVersion;
  const since = String(user.createdAt || '').slice(0, 10);
  return visibleTo(releases, user.role)
    .filter((r) => (seen ? compareVersions(r.version, seen) > 0 : !since || r.date >= since))
    .map((r) => r.version);
}

module.exports = { load, problems, compareVersions, visibleTo, unseenFor, VERSION };
