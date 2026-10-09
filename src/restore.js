'use strict';

// Getting things back out of a backup (made by backup.js).
//
// A backup night is an ordinary folder on the backup drive; its manifest lists
// every file with its size, date and checksum, and whether it is stored
// gzipped. This reads the manifest to browse a night like a folder tree, and
// opens files as they were (gunzipping the stored ones).
//
// Nothing here changes a backup, and nothing writes into live data on its own:
// the callers decide where files go (a new folder in Nest, a zip download, a
// folder on the server), and extract() refuses to overwrite anything.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const backup = require('./backup');

const NAME = /^\d{4}-\d\d-\d\d \d{4}(-\d+)?$/;

// manifest.files rows: [rel, size, mtimeMs, sha256, gzipped]
const SIZE = 1;
const MTIME = 2;
const GZ = 4;

const parts = (p) => String(p || '').split('/').filter(Boolean);

function cleanPath(p) {
  const list = parts(p);
  if (list.some((s) => s === '.' || s === '..' || s.includes('\0'))) return null;
  return list.join('/');
}

// A night on the drive, with its files grouped by folder so a folder's
// contents and totals are one lookup. Built once per night and kept.
class Night {
  constructor(dir, name, manifest) {
    this.dir = dir;
    this.name = name;
    this.createdAt = manifest.createdAt;
    this.files = manifest.files;
    this.folders = new Map([['', { folders: new Set(), files: [], count: 0, bytes: 0 }]]);
    this.byPath = new Map();
    for (const f of this.files) {
      this.byPath.set(f[0], f);
      const segs = f[0].split('/');
      // Every folder above this file gets its size and file count.
      for (let i = 0; i < segs.length; i++) {
        const folder = segs.slice(0, i).join('/');
        if (!this.folders.has(folder)) this.folders.set(folder, { folders: new Set(), files: [], count: 0, bytes: 0 });
        const info = this.folders.get(folder);
        info.count++;
        info.bytes += f[SIZE];
        if (i < segs.length - 1) info.folders.add(segs[i]);
        else info.files.push(f);
      }
    }
    const root = this.folders.get('');
    this.count = root.count;
    this.bytes = root.bytes;
  }

  kind(p) {
    if (this.byPath.has(p)) return 'file';
    if (this.folders.has(p)) return 'folder';
    return null;
  }

  // What is directly inside a folder, folders first.
  list(p) {
    const info = this.folders.get(p);
    if (!info) return null;
    const at = (name) => (p ? `${p}/${name}` : name);
    return {
      folders: [...info.folders].sort((a, b) => a.localeCompare(b)).map((name) => {
        const sub = this.folders.get(at(name));
        return { name, files: sub.count, bytes: sub.bytes };
      }),
      files: info.files
        .map((f) => ({ name: f[0].slice(f[0].lastIndexOf('/') + 1), size: f[SIZE], mtime: f[MTIME] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // Every file at or under a path.
  under(p) {
    const one = this.byPath.get(p);
    if (one) return [one];
    if (!this.folders.has(p)) return [];
    if (!p) return this.files;
    return this.files.filter((f) => f[0].startsWith(`${p}/`));
  }

  // Where a file is stored on the drive.
  stored(entry) {
    const file = path.join(this.dir, entry[GZ] ? `${entry[0]}.gz` : entry[0]);
    if (path.relative(this.dir, file).startsWith('..')) throw new Error('Path outside the backup');
    return file;
  }

  // The file as it was, ready to read.
  open(entry) {
    const raw = fs.createReadStream(this.stored(entry), { highWaterMark: 1 << 20 });
    if (!entry[GZ]) return raw;
    const gunzip = zlib.createGunzip();
    raw.on('error', (err) => gunzip.destroy(err));
    return raw.pipe(gunzip);
  }
}

// Opens nights on a backup drive. Keeps the last one in memory: browsing and
// restoring a night touches it many times.
class Backups {
  constructor(dir) {
    this.dir = dir;
    this.cache = null;
  }

  // Finished nights, newest first. Without a drive in sight, none.
  nights() {
    if (!this.dir || !fs.existsSync(path.join(this.dir, '.roost-backup'))) return [];
    return backup.listSnapshots(this.dir);
  }

  async night(name) {
    if (!NAME.test(String(name))) return null;
    const dir = path.join(this.dir, backup.ROOT, name);
    let stamp;
    try {
      stamp = (await fsp.stat(path.join(dir, backup.MANIFEST))).mtimeMs;
    } catch {
      return null;
    }
    if (this.cache && this.cache.name === name && this.cache.stamp === stamp) return this.cache.night;
    const manifest = await backup.readManifest(dir);
    if (!manifest) return null;
    const night = new Night(dir, name, manifest);
    this.cache = { name, stamp, night };
    return night;
  }
}

// ---------- extracting ----------

// Writes files from a night into `out`, keeping the folder layout and dates.
// Never overwrites: a file that is already there stops the restore.
//   entries   rows from night.under()
//   base      the path they are relative to ('' for the whole night)
async function extract(night, entries, out, { base = '', onFile, signal } = {}) {
  const cut = base ? base.length + 1 : 0;
  for (const entry of entries) {
    if (signal && signal.aborted) throw new Error('Restore cancelled');
    const rel = entry[0].slice(cut) || entry[0].slice(entry[0].lastIndexOf('/') + 1);
    const target = path.join(out, ...rel.split('/'));
    if (path.relative(out, target).startsWith('..')) throw new Error(`Refusing to write outside ${out}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(night.open(entry), fs.createWriteStream(target, { flags: 'wx' }));
    const when = new Date(entry[MTIME]);
    await fsp.utimes(target, when, when);
    if (onFile) onFile(entry);
  }
}

module.exports = { Backups, Night, extract, cleanPath, parts, NAME };
