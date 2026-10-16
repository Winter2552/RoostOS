'use strict';

// Move to Glint: brings a Google Photos library into Glint from Google Takeout zips.
//
// The zips are put in the Nest folder "Move to Glint" (an ordinary Nest upload,
// or copied there over the network). Starting the move reads each zip in place,
// one photo at a time, with nothing unpacked first:
//   - the date comes from the JSON file Google puts beside every photo, so the
//     timeline is right (the file's own EXIF is the fallback, read by the
//     browser later, as for any upload)
//   - favourites and albums carry over; Google's trash is left behind
//   - the same photo in a year folder and several albums is stored once. The
//     zip already holds each file's size and CRC, so repeats are spotted
//     without reading them
//   - photos already in Glint (same name and size) are skipped
// Every file's result is kept in a small table, so a stopped or restarted move
// carries on where it left off and a second run changes nothing.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { HttpError } = require('./http');
const { openZip } = require('./zip-read');
const { cleanName } = require('./nest');
const { mediaType, MEDIA_EXT } = require('./glint');

const FOLDER = 'Move to Glint';
const SIDECAR_MAX = 1024 * 1024;
const SUPPLEMENTAL = 'supplemental-metadata';
const TAKEN_MIN = Date.UTC(1900, 0, 1);
const TAKEN_MAX = Date.UTC(2200, 0, 1);
const USAGE_EVERY = 25; // tell Roost the new storage use every this many photos
const MEDIA_RE = new RegExp(`\\.(${MEDIA_EXT.join('|')})$`, 'i');
const STILL_EXT = ['heic', 'HEIC', 'jpg', 'JPG', 'jpeg', 'JPEG'];

const schema = (items, seen) => `
  CREATE TABLE IF NOT EXISTS ${items} (
    owner TEXT NOT NULL,
    zip TEXT NOT NULL,
    entry TEXT NOT NULL,
    status TEXT NOT NULL,   -- moved | nodate | dup | skipped | problem
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner, zip, entry)
  );
  CREATE TABLE IF NOT EXISTS ${seen} (
    owner TEXT NOT NULL,
    key TEXT NOT NULL,      -- "<size>:<crc>" of the file
    photo TEXT NOT NULL,
    PRIMARY KEY (owner, key)
  ) WITHOUT ROWID;
`;

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// Google names the JSON beside "IMG_1.jpg" in several ways over the years:
//   IMG_1.jpg.json                      (old)
//   IMG_1.jpg.supplemental-metadata.json (new, cut short when the name is long:
//                                         IMG_1.jpg.supplemental-metad.json)
//   a name cut to 46 characters         (old, long names)
//   IMG_1.jpg(1).json / IMG_1.jpg.supplemental-metadata(1).json for IMG_1(1).jpg
//   IMG_1-edited.jpg uses IMG_1.jpg's JSON
// Returns the names to look for, most likely first, in lower case.
function sidecarNames(file) {
  const variants = [file];
  const edited = /^(.*)-edited(\.[^./]+)?$/i.exec(file);
  if (edited) variants.push(edited[1] + (edited[2] || ''));
  const out = [];
  for (const v0 of variants) {
    const numbered = /^(.*)\((\d+)\)(\.[^./]+)?$/.exec(v0);
    const pairs = numbered ? [[numbered[1] + (numbered[3] || ''), `(${numbered[2]})`], [v0, '']] : [[v0, '']];
    for (const [v, n] of pairs) {
      out.push(`${v}${n}.json`);
      for (let k = SUPPLEMENTAL.length; k >= 1; k--) out.push(`${v}.${SUPPLEMENTAL.slice(0, k)}${n}.json`);
      if (v.length > 46) out.push(`${v.slice(0, 46)}${n}.json`);
    }
  }
  return [...new Set(out.map((n) => n.toLowerCase()))];
}

// A Live Photo's video has no JSON of its own: it shares its photo's.
function stillNames(file) {
  const dot = file.lastIndexOf('.');
  if (dot < 1 || !/^\.(mp4|mov)$/i.test(file.slice(dot))) return [];
  return STILL_EXT.flatMap((e) => sidecarNames(`${file.slice(0, dot)}.${e}`));
}

function unixMs(t) {
  const sec = Number(t && t.timestamp);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const ms = Math.round(sec * 1000);
  return ms >= TAKEN_MIN && ms < TAKEN_MAX ? ms : null;
}

class Importer {
  // folder: the Nest folder the zips are put in. items and seen: this move's tables
  // (Move to Nest has its own, so the two never mix).
  constructor({ glint, nest, folder = FOLDER, items = 'import_items', seen = 'import_seen' }) {
    this.glint = glint;
    this.nest = nest;
    this.db = nest.db;
    this.db.exec(schema(items, seen));
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      stage: q(`SELECT id FROM nodes WHERE owner = ? AND parent = '' AND kind = 'folder' AND trash_root IS NULL
                AND name = ? COLLATE NOCASE`),
      zips: q(`SELECT id, name, size FROM nodes WHERE owner = ? AND parent = ? AND kind = 'file' AND trash_root IS NULL
               AND lower(name) LIKE '%.zip' ORDER BY name COLLATE NOCASE`),
      done: q(`SELECT zip, entry FROM ${items} WHERE owner = ?`),
      record: q(`INSERT OR REPLACE INTO ${items} (owner, zip, entry, status, note) VALUES (?, ?, ?, ?, ?)`),
      counts: q(`SELECT zip, status, COUNT(*) AS n FROM ${items} WHERE owner = ? GROUP BY zip, status`),
      problems: q(`SELECT zip, entry, note FROM ${items} WHERE owner = ? AND status = 'problem' ORDER BY rowid DESC LIMIT 100`),
      zipProblems: q(`SELECT 1 FROM ${items} WHERE owner = ? AND zip = ? AND status = 'problem' LIMIT 1`),
      seen: q(`SELECT photo FROM ${seen} WHERE owner = ? AND key = ?`),
      see: q(`INSERT OR IGNORE INTO ${seen} (owner, key, photo) VALUES (?, ?, ?)`),
      same: q(`SELECT id FROM nodes WHERE owner = ? AND size = ? AND kind = 'file' AND trash_root IS NULL
               AND name = ? COLLATE NOCASE LIMIT 1`),
      photo: q('INSERT OR REPLACE INTO photos (id, owner, taken, fav, date_src) VALUES (?, ?, ?, ?, ?)'),
      albumByName: q('SELECT id FROM albums WHERE owner = ? AND name = ? COLLATE NOCASE LIMIT 1'),
    };
    this.folder = folder;
    this.jobs = new Map(); // user id -> the move that is running or just ran
  }

  // ---------- the folder and its zips ----------

  stage(user, create = false) {
    const row = this.q.stage.get(user.id, this.folder);
    if (row) return row.id;
    return create ? this.nest.ensurePath(user, '', this.folder) : '';
  }

  zips(user) {
    const folder = this.stage(user);
    return folder ? this.q.zips.all(user.id, folder) : [];
  }

  status(user) {
    const job = this.jobs.get(user.id);
    const counts = { moved: 0, nodate: 0, dup: 0, skipped: 0, problem: 0 };
    const byZip = new Map();
    for (const r of this.q.counts.all(user.id)) {
      if (r.status in counts) counts[r.status] += r.n;
      const z = byZip.get(r.zip) || { done: 0, problems: 0 };
      z.done += r.n;
      if (r.status === 'problem') z.problems += r.n;
      byZip.set(r.zip, z);
    }
    return {
      folder: this.folder,
      zips: this.zips(user).map((z) => ({ id: z.id, name: z.name, size: z.size, ...(byZip.get(z.name) || { done: 0, problems: 0 }) })),
      counts,
      problems: this.q.problems.all(user.id).map((p) => ({ zip: p.zip, name: p.entry.slice(p.entry.lastIndexOf('/') + 1), note: p.note })),
      job: job ? { running: job.running, stopping: job.stop, phase: job.phase, total: job.total, done: job.done, current: job.current, error: job.error, finished: job.finished } : null,
    };
  }

  // ---------- running a move ----------

  start(user, { deleteZips = false } = {}) {
    const old = this.jobs.get(user.id);
    if (old && old.running) throw new HttpError(409, 'A move is already running');
    if (!this.zips(user).length) throw new HttpError(400, `Put your Google Takeout zip files in the ${this.folder} folder first`);
    const job = { running: true, stop: false, phase: 'reading', total: 0, done: 0, current: '', error: '', finished: false, deleteZips: Boolean(deleteZips) };
    this.jobs.set(user.id, job);
    this.run(user, job).catch((err) => {
      job.error = err instanceof HttpError ? err.message : `Stopped: ${err.message}`;
    }).finally(() => {
      job.running = false;
      job.phase = 'idle';
      job.current = '';
      job.finished = !job.error && !job.stop;
    });
    return this.status(user);
  }

  stop(user) {
    const job = this.jobs.get(user.id);
    if (job && job.running) job.stop = true;
    return this.status(user);
  }

  // Deletes the zips for good, once the move is over. Never automatic unless asked for at Start.
  async deleteZips(user) {
    const job = this.jobs.get(user.id);
    if (job && job.running) throw new HttpError(409, 'Wait for the move to stop first');
    const ids = this.zips(user).map((z) => z.id);
    if (ids.length) {
      this.nest.trash(user, ids);
      await this.nest.deleteForever(user, ids);
    }
    return this.status(user);
  }

  async run(user, job) {
    const nest = this.nest;
    const done = new Set(this.q.done.all(user.id).map((r) => `${r.zip}\0${r.entry}`));
    const open = []; // { name, id, zip, refs }
    const dirs = new Map(); // folder path -> Map(lower-case file name -> { z, entry }) of JSON files
    const media = [];
    const albumIds = new Map();
    const touched = new Set();
    let sinceUsage = 0;

    try {
      // 1. Read each zip's list of files (quick, even for huge zips).
      for (const row of this.zips(user)) {
        if (job.stop) break;
        let zip;
        try {
          zip = await openZip(nest.diskPath(user, row.id));
        } catch (err) {
          this.q.record.run(user.id, row.name, '(zip)', 'problem', err.message);
          continue;
        }
        const z = { name: row.name, id: row.id, zip, refs: 0 };
        open.push(z);
        for (const entry of zip.entries) {
          if (entry.dir || entry.name.startsWith('__MACOSX/')) continue;
          const slash = entry.name.lastIndexOf('/');
          const dir = entry.name.slice(0, slash + 1);
          const file = entry.name.slice(slash + 1);
          if (/\.json$/i.test(file)) {
            if (!dirs.has(dir)) dirs.set(dir, new Map());
            dirs.get(dir).set(file.toLowerCase(), { z, entry });
          } else if (MEDIA_RE.test(file) && !done.has(`${z.name}\0${entry.name}`)) {
            media.push({ z, entry, dir, file });
          }
        }
      }
      const yearNames = this.yearFolders(dirs, media);
      job.total = media.length;
      job.phase = 'moving';

      // 2. Move the photos, one at a time.
      // Count what still needs each zip, so a zip is only deleted (if asked) when nothing does.
      for (const item of media) {
        item.side = this.sidecar(dirs, item);
        item.z.refs++;
        if (item.side && item.side.z !== item.z) item.side.z.refs++;
      }
      for (const item of media) {
        if (job.stop) break;
        job.current = item.file;
        let result;
        try {
          result = await this.one(user, job, item, yearNames, albumIds, touched);
        } catch (err) {
          if (err instanceof HttpError) throw err; // out of space: stop, don't fail every file
          result = { status: 'problem', note: err.message };
        }
        this.q.record.run(user.id, item.z.name, item.entry.name, result.status, result.note || '');
        job.done++;
        if (++sinceUsage >= USAGE_EVERY) { sinceUsage = 0; nest.changed(user); }
        item.z.refs--;
        if (item.side && item.side.z !== item.z) item.side.z.refs--;
        if (job.deleteZips) await this.maybeDelete(user, open, item.z, item.side && item.side.z);
      }
    } finally {
      nest.changed(user);
      const now = Date.now();
      for (const id of touched) this.glint.q.touchAlbum.run(now, id);
      for (const z of open) await z.zip.close().catch(() => {});
    }
  }

  // With "delete each zip when done": a zip goes once nothing left needs it
  // (its own photos, or JSON that another zip's photos use) and it had no problems.
  async maybeDelete(user, open, ...zs) {
    for (const z of new Set(zs.filter(Boolean))) {
      if (z.refs > 0 || z.gone || this.q.zipProblems.get(user.id, z.name)) continue;
      z.gone = true;
      await z.zip.close().catch(() => {});
      this.nest.trash(user, [z.id]);
      await this.nest.deleteForever(user, [z.id]);
    }
  }

  // Folders named like "Photos from 2019" are the year view of the library, not
  // albums. Google translates the name, so also treat "<same words> <year>"
  // appearing for two or more years as year folders.
  yearFolders(dirs, media) {
    const folders = new Set();
    for (const m of media) folders.add(m.dir.split('/').filter(Boolean).pop() || '');
    const prefixes = new Map();
    for (const f of folders) {
      const m = /^(\D+?)\s*(\d{4})$/.exec(f);
      if (m) {
        if (!prefixes.has(m[1])) prefixes.set(m[1], new Set());
        prefixes.get(m[1]).add(m[2]);
      }
    }
    const years = new Set();
    for (const f of folders) {
      const m = /^(\D+?)\s*(\d{4})$/.exec(f);
      if (m && (/^photos from$/i.test(m[1]) || prefixes.get(m[1]).size >= 2)) years.add(f);
    }
    return years;
  }

  sidecar(dirs, item) {
    const folder = dirs.get(item.dir);
    if (!folder) return null;
    for (const name of [...sidecarNames(item.file), ...stillNames(item.file)]) {
      const hit = folder.get(name);
      if (hit) return hit;
    }
    return null;
  }

  async readJson(side) {
    try {
      let size = 0;
      const chunks = [];
      for await (const c of await side.z.zip.open(side.entry)) {
        size += c.length;
        if (size > SIDECAR_MAX) return null;
        chunks.push(c);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  albumId(user, name, cache) {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const found = this.q.albumByName.get(user.id, name);
    const id = found ? found.id : this.glint.createAlbum(user, name).id;
    cache.set(key, id);
    return id;
  }

  addToAlbum(user, photoId, folder, yearNames, albumIds, touched) {
    if (!folder || yearNames.has(folder) || /^(archive|trash|bin)$/i.test(folder)) return;
    if (!this.glint.find(user, photoId)) return; // deleted since: leave it out
    const album = this.albumId(user, folder.slice(0, 80), albumIds);
    this.glint.q.addToAlbum.run(album, photoId, Date.now());
    touched.add(album);
  }

  // One photo or video. Returns { status, note }.
  async one(user, job, item, yearNames, albumIds, touched) {
    const { entry, file } = item;
    const folder = item.dir.split('/').filter(Boolean).pop() || '';
    const meta = item.side ? await this.readJson(item.side) : null;
    if (/^(trash|bin)$/i.test(folder) || (meta && meta.trashed === true)) return { status: 'skipped', note: 'In Google Photos trash' };

    const nest = this.nest;
    const key = `${entry.size}:${entry.crc}`;
    let existing = (this.q.seen.get(user.id, key) || {}).photo;
    if (!existing) {
      const same = this.q.same.get(user.id, entry.size, file.slice(0, 240));
      if (same) {
        existing = same.id;
        this.q.see.run(user.id, key, existing);
      }
    }
    if (existing) {
      this.addToAlbum(user, existing, folder, yearNames, albumIds, touched);
      return { status: 'dup' };
    }

    nest.checkSpace(user, entry.size); // throws an HttpError when the limit or drive is full
    const dated = meta ? unixMs(meta.photoTakenTime) || unixMs(meta.creationTime) : null;
    const modified = entry.mtime >= Date.UTC(1990, 0, 1) && entry.mtime <= Date.now() + 86400000 ? entry.mtime : Date.now();
    const taken = dated || modified;
    const year = Math.min(2199, Math.max(1900, new Date(taken).getFullYear()));
    const parent = nest.ensurePath(user, '', `Photos/${year}`);
    const name = nest.uniqueName(user, parent, cleanName(file) || 'photo');
    const temp = nest.uploadPath(user, `import-${newId()}`);
    await fsp.mkdir(path.dirname(temp), { recursive: true });
    try {
      await pipeline(await item.z.zip.open(entry), fs.createWriteStream(temp, { flags: 'wx' }));
      const when = new Date(taken);
      await fsp.utimes(temp, when, when);
      await fsp.rename(temp, path.join(nest.diskPath(user, parent), name));
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
    }
    const id = newId();
    nest.q.insert.run(id, user.id, parent, name, 'file', entry.size, mediaType({ mime: '', name }) || 'application/octet-stream', Date.now(), taken);
    this.q.photo.run(id, user.id, taken, meta && meta.favorited === true ? 1 : 0, dated ? 1 : 0);
    this.q.see.run(user.id, key, id);
    this.addToAlbum(user, id, folder, yearNames, albumIds, touched);
    return { status: dated ? 'moved' : 'nodate', note: dated ? '' : 'No date from Google; using the file date' };
  }
}

module.exports = { Importer, FOLDER, sidecarNames, SIDECAR_MAX };
