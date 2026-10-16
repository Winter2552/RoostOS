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
    this.q.sameAt = this.db.prepare(`SELECT 1 FROM nodes WHERE owner = ? AND parent = ? AND kind = 'file' AND trash_root IS NULL
                                     AND name = ? COLLATE NOCASE AND size = ? LIMIT 1`);
  }

  async run(user, job) {
    const nest = this.nest;
    const done = new Set(this.q.done.all(user.id).map((r) => `${r.zip}\0${r.entry}`));
    const open = [];
    const files = [];
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
          if (!file || JUNK.test(file) || done.has(`${z.name}\0${entry.name}`)) continue;
          files.push({ z, entry, dir: [...root, ...parts].join('/'), file });
        }
      }
      job.total = files.length;
      job.phase = 'moving';
      for (const item of files) item.z.refs++;

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
        if (job.deleteZips) await this.maybeDelete(user, open, item.z);
      }
    } finally {
      nest.changed(user);
      for (const z of open) await z.zip.close().catch(() => {});
    }
  }

  // One file. Returns { status, note }.
  async copy(user, item) {
    const nest = this.nest;
    const { entry } = item;
    const parent = nest.ensurePath(user, '', item.dir);
    const name = cleanName(item.file) || 'file';
    if (this.q.sameAt.get(user.id, parent, name, entry.size)) return { status: 'dup' };
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
    nest.q.insert.run(newId(), user.id, parent, final, 'file', entry.size, mediaType({ mime: '', name: final }) || '', Date.now(), modified);
    return { status: 'moved' };
  }
}

module.exports = { NestImporter, FOLDER, DEST, SHARED };
