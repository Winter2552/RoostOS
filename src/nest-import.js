'use strict';

// Move to Nest: brings a Google Drive into Nest from zips.
//
// Same idea as Move to Glint (src/glint-import.js), which it builds on: zips
// are put in the Nest folder "Move to Nest", then read where they are, one file
// at a time. Two kinds of zip are understood:
//   - a Google Takeout of Drive (everything under Takeout/Drive/): the folder
//     tree is rebuilt inside "From Google Drive". Docs, Sheets and Slides come
//     as Word, Excel and PowerPoint files, because that is what Takeout gives.
//   - an ordinary zip from Drive's own Download button (how files and folders
//     shared with you are taken): its contents go inside
//     "From Google Drive/Shared with me".
// Files keep their modified date. A file already there with the same name and
// size is skipped, so a second run, or a second export, adds only what's new.
//
// Drive's Takeout also writes a "<file>-info.json" beside every file. When one
// has its main file it is read, kept as the file's Info (src/file-info.js) and
// not copied, so it never shows up as a file. A .json with no main file is just
// a file like any other and is copied as it is.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { HttpError } = require('./http');
const { openZip } = require('./zip-read');
const { cleanName } = require('./nest');
const { mediaType } = require('./glint');
const { Importer } = require('./glint-import');
const { parseBytes, driveInfoNames, SIDECAR_MAX } = require('./file-info');

const FOLDER = 'Move to Nest';
const DEST = 'From Google Drive';
const SHARED = 'Shared with me';
const DRIVE_PREFIX = 'Takeout/Drive/';
const USAGE_EVERY = 25;
const JUNK = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i;

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

class NestImporter extends Importer {
  constructor({ glint, nest }) {
    super({ glint, nest, folder: FOLDER, items: 'nest_import_items', seen: 'nest_import_seen' });
    const inDest = `WITH RECURSIVE d(id) AS (
                      SELECT ?1 UNION ALL
                      SELECT n.id FROM nodes n JOIN d ON n.parent = d.id WHERE n.trash_root IS NULL AND n.kind = 'folder'
                    )`;
    // Tidy up: the .json files under From Google Drive, a file beside one, and a file by Drive title and size.
    this.q.jsonIn = this.db.prepare(`${inDest} SELECT * FROM nodes WHERE owner = ?2 AND kind = 'file' AND trash_root IS NULL
                                     AND lower(name) LIKE '%.json' AND parent IN (SELECT id FROM d) ORDER BY id`);
    this.q.beside = this.db.prepare(`SELECT id FROM nodes WHERE owner = ? AND parent = ? AND kind = 'file' AND trash_root IS NULL
                                     AND name = ? COLLATE NOCASE AND id != ?`);
    this.q.byTitle = this.db.prepare(`${inDest} SELECT id FROM nodes WHERE owner = ?2 AND kind = 'file' AND trash_root IS NULL
                                      AND name = ?3 COLLATE NOCASE AND size = ?4 AND parent IN (SELECT id FROM d) LIMIT 2`);
    this.q.sameAt = this.db.prepare(`SELECT id FROM nodes WHERE owner = ? AND parent = ? AND kind = 'file' AND trash_root IS NULL
                                     AND name = ? COLLATE NOCASE AND size = ? LIMIT 1`);
  }

  async run(user, job) {
    const nest = this.nest;
    const done = new Set(this.q.done.all(user.id).map((r) => `${r.zip}\0${r.entry}`));
    const open = [];
    const files = [];
    const mains = []; // every file that isn't JSON, done or not: sidecars are matched to these
    const jsons = new Map(); // destination folder -> Map(lower-case name -> JSON file)
    const jsonItems = [];
    let sinceUsage = 0;

    try {
      // 1. Read each zip's list of files and work out where each goes.
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
        const takeout = zip.entries.some((e) => e.name.startsWith(DRIVE_PREFIX));
        const root = takeout ? [DEST] : [DEST, SHARED];
        for (const entry of zip.entries) {
          if (entry.name.startsWith('__MACOSX/')) continue;
          let rel = entry.name;
          if (takeout) {
            if (!rel.startsWith(DRIVE_PREFIX)) continue; // other Google products in the same export
            rel = rel.slice(DRIVE_PREFIX.length);
          }
          const parts = rel.split('/');
          const file = parts.pop();
          if (entry.dir) {
            // Empty folders come across too.
            nest.ensurePath(user, '', [...root, ...parts].join('/'));
            continue;
          }
          if (!file || JUNK.test(file)) continue;
          const it = { z, entry, dir: [...root, ...parts].join('/'), file, done: done.has(`${z.name}\0${entry.name}`) };
          if (/\.json$/i.test(file)) {
            if (!jsons.has(it.dir)) jsons.set(it.dir, new Map());
            jsons.get(it.dir).set(file.toLowerCase(), it);
            jsonItems.push(it);
          } else {
            mains.push(it);
          }
        }
      }
      await this.matchSidecars(mains, jsons, jsonItems);
      for (const it of [...mains, ...jsonItems]) {
        if (!it.done && !it.claimed) files.push(it);
      }
      job.total = files.length;
      job.phase = 'moving';
      for (const item of files) {
        item.z.refs++;
        if (item.side && item.side.z !== item.z) item.side.z.refs++;
      }

      // 2. Copy the files, one at a time.
      for (const item of files) {
        if (job.stop) break;
        job.current = item.file;
        let result;
        try {
          result = await this.copy(user, item);
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
      for (const z of open) await z.zip.close().catch(() => {});
    }
  }

  // Info files that earlier moves left in Nest as ordinary files. Each one that
  // has its main file is merged into that file's Info and (with apply) moved to
  // the trash, where it can be restored for 30 days. A .json with no main file
  // is left exactly where it is. Without apply it only counts.
  async tidy(user, apply) {
    const old = this.jobs.get(user.id);
    if (old && old.running) throw new HttpError(409, 'Wait for the move to finish first');
    const nest = this.nest;
    const dest = nest.q.findFolder.get(user.id, '', DEST);
    const out = { found: 0, left: 0, tidied: 0 };
    if (!dest) return out;
    const gone = [];
    for (const j of this.q.jsonIn.all(dest.id, user.id)) {
      const meta = await this.readNode(user, j);
      let main = null;
      if (meta && meta.source === 'drive') {
        const m = /^(.+?)(-info)?\.json$/i.exec(j.name);
        const hit = m && this.q.beside.get(user.id, j.parent, m[1], j.id);
        if (hit) main = hit.id;
        else if (meta.title && meta.size !== undefined && /-info\.json$/i.test(j.name)) {
          const found = this.q.byTitle.all(dest.id, user.id, meta.title, meta.size);
          if (found.length === 1) main = found[0].id;
        }
      }
      if (!main) { out.left++; continue; }
      out.found++;
      if (apply) { nest.setInfo(user, main, meta); gone.push(j.id); }
    }
    if (apply) {
      out.tidied = nest.trash(user, gone).length;
      nest.changed(user);
    }
    return out;
  }

  async readNode(user, n) {
    try {
      if (n.size > SIDECAR_MAX) return null;
      return parseBytes(await fsp.readFile(this.nest.diskPath(user, n.id)));
    } catch {
      return null;
    }
  }

  // Pairs each main file with its info JSON (item.side, item.meta) and marks the
  // JSON claimed. Only a JSON that has a main file and reads as a Google info
  // file is claimed; every other JSON is left to be copied like any file.
  async matchSidecars(mains, jsons, jsonItems) {
    const claim = (main, side, meta) => {
      side.claimed = true;
      main.side = side;
      main.meta = meta;
    };
    for (const main of mains) {
      const here = jsons.get(main.dir);
      if (!here) continue;
      for (const name of driveInfoNames(main.file)) {
        const side = here.get(name);
        if (!side || side.claimed) continue;
        const meta = await this.readSidecar(side);
        if (meta && meta.source === 'drive') { claim(main, side, meta); break; }
      }
    }
    // A sidecar that sits apart from its file (another folder or zip): match on
    // Drive's own title and size, and only when that is unambiguous.
    const loose = mains.filter((m) => !m.side);
    const spare = jsonItems.filter((j) => !j.claimed && /-info\.json$/i.test(j.file));
    if (!loose.length || !spare.length) return;
    const byTitle = new Map();
    for (const side of spare) {
      const meta = await this.readSidecar(side);
      if (!meta || meta.source !== 'drive' || !meta.title || meta.size === undefined) continue;
      const key = `${meta.title}\0${meta.size}`;
      byTitle.set(key, byTitle.has(key) ? null : { side, meta });
    }
    for (const main of loose) {
      const hit = byTitle.get(`${main.file}\0${main.entry.size}`);
      if (hit && !hit.side.claimed) claim(main, hit.side, hit.meta);
    }
  }

  async readSidecar(side) {
    if (side.parsed !== undefined) return side.parsed;
    side.parsed = null;
    try {
      if (side.entry.size > SIDECAR_MAX) return null;
      const chunks = [];
      for await (const c of await side.z.zip.open(side.entry)) chunks.push(c);
      side.parsed = parseBytes(Buffer.concat(chunks));
    } catch {
      side.parsed = null;
    }
    return side.parsed;
  }

  // One file. Returns { status, note }.
  async copy(user, item) {
    const nest = this.nest;
    const { entry } = item;
    const parent = nest.ensurePath(user, '', item.dir);
    const name = cleanName(item.file) || 'file';
    const same = this.q.sameAt.get(user.id, parent, name, entry.size);
    if (same) {
      if (item.meta) nest.setInfo(user, same.id, item.meta);
      return { status: 'dup' };
    }
    nest.checkSpace(user, entry.size); // throws an HttpError when the limit or drive is full
    const final = nest.uniqueName(user, parent, name);
    const modified = entry.mtime >= Date.UTC(1990, 0, 1) && entry.mtime <= Date.now() + 86400000 ? entry.mtime : Date.now();
    const temp = nest.uploadPath(user, `import-${newId()}`);
    await fsp.mkdir(path.dirname(temp), { recursive: true });
    try {
      await pipeline(await item.z.zip.open(entry), fs.createWriteStream(temp, { flags: 'wx' }));
      const when = new Date(modified);
      await fsp.utimes(temp, when, when);
      await fsp.rename(temp, path.join(nest.diskPath(user, parent), final));
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
    }
    const id = newId();
    nest.q.insert.run(id, user.id, parent, final, 'file', entry.size, mediaType({ mime: '', name: final }) || '', Date.now(), modified);
    if (item.meta) nest.setInfo(user, id, item.meta);
    return { status: 'moved' };
  }
}

module.exports = { NestImporter, FOLDER, DEST, SHARED };
