#!/usr/bin/env node
'use strict';

// Turns releases/next.json into a new release.
//   node scripts/release.js 0.1.1 "Title" "One line summary"
//   node scripts/release.js --patch "Title" "Summary"   (0.1 → 0.1.1 → 0.1.2)
//   node scripts/release.js --minor "Title" "Summary"   (0.1.2 → 0.2)
// Writes releases/<version>.json, bumps package.json, empties next.json.

const fs = require('fs');
const path = require('path');
const { load, problems, compareVersions, VERSION } = require('../src/releases');

const dir = path.join(__dirname, '..', 'releases');
const pkgFile = path.join(__dirname, '..', 'package.json');

function nextVersion(arg, current) {
  const [major, minor, patch = 0] = current.split('.').map(Number);
  if (arg === '--patch') return `${major}.${minor}.${patch + 1}`;
  if (arg === '--minor') return `${major}.${minor + 1}`;
  return arg;
}

function main(argv) {
  const [arg, title, summary = ''] = argv;
  if (!arg || !title) throw new Error('Usage: release.js <version|--patch|--minor> "Title" ["Summary"]');
  const existing = load(dir);
  const current = existing.length ? existing[0].version : '0.0';
  const version = nextVersion(arg, current);
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version like 0.1 or 0.1.1`);
  if (existing.length && compareVersions(version, current) <= 0) throw new Error(`${version} is not newer than ${current}`);
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'next.json'), 'utf8'));
  const rel = { version, date: new Date().toISOString().slice(0, 10), title, summary, items: next.items };
  const bad = problems(rel, dir);
  if (bad.length) throw new Error(`next.json is not ready: ${bad.join('; ')}`);
  fs.writeFileSync(path.join(dir, `${version}.json`), `${JSON.stringify(rel, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'next.json'), '{\n  "items": []\n}\n');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = version.split('.').length === 2 ? `${version}.0` : version;
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Released v${version}`);
}

try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(1); }
