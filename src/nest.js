'use strict';

// Nest: Roost's own file storage, built to work like Google Drive.
//
// Files are ordinary files and folders on the data drive, laid out exactly as
// the user sees them, so they stay readable without Roost:
//   <NEST_DIR>/<username>_<user id>/files/...         My Drive
//   <NEST_DIR>/<username>_<user id>/trash/<id>/...    each item in the trash
//   <NEST_DIR>/<username>_<user id>/.uploads/<id>     uploads in progress
// What a folder on disk can't hold (ids, trash dates, upload progress) lives
// in SQLite, using node:sqlite, which is built into Node 22.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { HttpError, send, readJson, str } = require('./http');
const zip = require('./zip');

const CHUNK = 16 * 1024 * 1024; // upload piece size: small enough to retry cheaply
const PAGE = 200; // items per folder page
const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_TTL = DAY; // unfinished uploads are dropped after a day
const DISK_RESERVE = 1024 ** 3; // always leave 1 GB free on the drive
const MAX_IDS = 1000;

const SORTS = { name: 'name COLLATE NOCASE', modified: 'modified', size: 'size' };

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    parent TEXT NOT NULL,           -- '' is the top of My Drive
    name TEXT NOT NULL,
    kind TEXT NOT NULL,             -- 'folder' or 'file'
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    trashed INTEGER,                -- when this item itself went in the trash
    trash_root TEXT                 -- on everything in the trash: the trashed item it is under
  );
  CREATE INDEX IF NOT EXISTS nodes_children ON nodes (owner, parent, trash_root);
  CREATE INDEX IF NOT EXISTS nodes_trash_root ON nodes (trash_root);
  CREATE INDEX IF NOT EXISTS nodes_trashed ON nodes (trashed);
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS uploads_owner ON uploads (owner);
`;

// Names that work on Linux, Windows and Mac alike, so files can later be
// opened as a network drive from any of them.
function cleanName(raw) {
  let n = String(raw || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') return '';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  while (Buffer.byteLength(n) > 240) n = n.slice(0, -1);
  return n;
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function item(n) {
  return { id: n.id, name: n.name, kind: n.kind, size: n.size, mime: n.mime, modified: n.modified };
}

function idList(v) {
  if (!Array.isArray(v) || !v.length || v.length > MAX_IDS || !v.every((x) => typeof x === 'string')) {
    throw new HttpError(400, 'Pick at least one item');
  }
  return [...new Set(v)];
}

// Content-Disposition with a plain fallback and the real (UTF-8) name.
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

class Nest {
  // dir: where files go. dbFile: the SQLite file. users(id): look up a Roost
  // user. limitOf(user): { limitBytes, otherBytes } from Roost's storage limits.
  // onUsage(user, bytes): Nest's usage changed.
  constructor({ dir, dbFile, users, limitOf, onUsage }) {
    this.dir = dir;
    this.users = users;
    this.limitOf = limitOf;
    this.onUsage = onUsage;
    this.busy = new Set();
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(SCHEMA);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      get: q('SELECT * FROM nodes WHERE id = ? AND owner = ?'),
      insert: q(`INSERT INTO nodes (id, owner, parent, name, kind, size, mime, created, modified)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      taken: q(`SELECT 1 FROM nodes WHERE owner = ? AND parent = ? AND trash_root IS NULL
                AND name = ? COLLATE NOCASE AND id != ?`),
      findFolder: q(`SELECT * FROM nodes WHERE owner = ? AND parent = ? AND trash_root IS NULL
                     AND kind = 'folder' AND name = ? COLLATE NOCASE`),
      count: q('SELECT COUNT(*) AS n FROM nodes WHERE owner = ? AND parent = ? AND trash_root IS NULL'),
      // The item and its parents, top first. Climbing stops at a trashed item,
      // so for anything in the trash the top row is the item that was trashed.
      chain: q(`WITH RECURSIVE a(id, parent, name, trashed, depth) AS (
                  SELECT id, parent, name, trashed, 0 FROM nodes WHERE id = ?
                  UNION ALL
                  SELECT n.id, n.parent, n.name, n.trashed, a.depth + 1
                  FROM nodes n JOIN a ON n.id = a.parent WHERE a.trashed IS NULL
                ) SELECT id, name, trashed FROM a ORDER BY depth DESC`),
      // Everything inside a live item, with paths relative to its parent.
      tree: q(`WITH RECURSIVE d(id, kind, size, modified, rel) AS (
                 SELECT id, kind, size, modified, name FROM nodes WHERE id = ?
                 UNION ALL
                 SELECT n.id, n.kind, n.size, n.modified, d.rel || '/' || n.name
                 FROM nodes n JOIN d ON n.parent = d.id WHERE n.trash_root IS NULL
               ) SELECT * FROM d`),
      rename: q('UPDATE nodes SET name = ?, modified = ? WHERE id = ?'),
      move: q('UPDATE nodes SET parent = ?, name = ? WHERE id = ?'),
      trash: q(`UPDATE nodes SET trash_root = ?2 WHERE id IN (
                  WITH RECURSIVE d(id) AS (
                    SELECT ?1 UNION ALL
                    SELECT n.id FROM nodes n JOIN d ON n.parent = d.id WHERE n.trash_root IS NULL
                  ) SELECT id FROM d)`),
      markTrashed: q('UPDATE nodes SET trashed = ? WHERE id = ?'),
      restore: q('UPDATE nodes SET trash_root = NULL WHERE trash_root = ?'),
      restoreRoot: q('UPDATE nodes SET trashed = NULL, parent = ?, name = ? WHERE id = ?'),
      forget: q('DELETE FROM nodes WHERE trash_root = ?'),
      trashList: q('SELECT * FROM nodes WHERE owner = ? AND trashed IS NOT NULL ORDER BY trashed DESC'),
      expired: q('SELECT id, owner FROM nodes WHERE trashed IS NOT NULL AND trashed < ?'),
      usage: q('SELECT COALESCE(SUM(size), 0) AS n FROM nodes WHERE owner = ?'),
      owners: q('SELECT DISTINCT owner FROM nodes'),
      reserved: q('SELECT COALESCE(SUM(size), 0) AS total, COALESCE(SUM(size - received), 0) AS pending FROM uploads WHERE owner = ?'),
      allPending: q('SELECT COALESCE(SUM(size - received), 0) AS n FROM uploads'),
      upload: q('SELECT * FROM uploads WHERE id = ? AND owner = ?'),
      addUpload: q('INSERT INTO uploads (id, owner, parent, name, size, mime, created) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      setReceived: q('UPDATE uploads SET received = ? WHERE id = ?'),
      dropUpload: q('DELETE FROM uploads WHERE id = ?'),
      staleUploads: q('SELECT id, owner FROM uploads WHERE created < ?'),
    };
    this.pages = new Map();
  }

  close() {
    this.db.close();
  }

  // ---------- paths ----------

  home(user) {
    return path.join(this.dir, `${user.username}_${user.id}`);
  }

  diskPath(user, id) {
    if (!id) return path.join(this.home(user), 'files');
    const chain = this.q.chain.all(id);
    const names = chain.map((c) => c.name);
    if (chain[0].trashed != null) return path.join(this.home(user), 'trash', chain[0].id, ...names);
    return path.join(this.home(user), 'files', ...names);
  }

  uploadPath(user, id) {
    return path.join(this.home(user), '.uploads', id);
  }

  // ---------- lookups ----------

  node(user, id, kind) {
    const n = id ? this.q.get.get(id, user.id) : null;
    if (!n || n.trash_root != null || (kind && n.kind !== kind)) {
      throw new HttpError(404, kind === 'folder' ? 'That folder no longer exists' : 'That item no longer exists');
    }
    return n;
  }

  folder(user, id) {
    return !id || id === 'root' ? { id: '', name: 'My Drive' } : this.node(user, id, 'folder');
  }

  // A free name in a folder: "Report.pdf", then "Report (1).pdf", ...
  uniqueName(user, parent, name, exceptId = '') {
    const dir = this.diskPath(user, parent);
    const free = (n) => !this.q.taken.get(user.id, parent, n, exceptId) && !fs.existsSync(path.join(dir, n));
    if (free(name)) return name;
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 1; ; i++) {
      const n = `${base} (${i})${ext}`;
      if (free(n)) return n;
    }
  }

  usage(user) {
    return this.q.usage.get(user.id).n;
  }

  changed(user) {
    this.onUsage(user, this.usage(user));
  }

  storage(user) {
    const { limitBytes, otherBytes } = this.limitOf(user);
    const nestBytes = this.usage(user);
    return { usedBytes: otherBytes + nestBytes, nestBytes, limitBytes };
  }

  // Refuses `bytes` more if it would go over the user's limit or fill the drive.
  checkSpace(user, bytes) {
    const { limitBytes, otherBytes } = this.limitOf(user);
    const reserved = this.q.reserved.get(user.id);
    if (limitBytes !== null) {
      const left = limitBytes - otherBytes - this.usage(user) - reserved.total;
      if (bytes > left) {
        throw new HttpError(413, `Not enough space: ${gbText(Math.max(0, left))} left of your ${gbText(limitBytes)}. Ask an admin for more on your Profile.`);
      }
    }
    try {
      const s = fs.statfsSync(this.dir);
      const free = s.bavail * s.bsize - this.q.allPending.get().n - DISK_RESERVE;
      if (bytes > free) throw new HttpError(507, 'The Roost drive is full');
    } catch (err) {
      if (err instanceof HttpError) throw err;
    }
  }

  // ---------- folders ----------

  list(user, id, { sort = 'name', dir = 'asc', offset = 0, foldersOnly = false } = {}) {
    const folder = this.folder(user, id);
    const col = SORTS[sort] || SORTS.name;
    const order = dir === 'desc' ? 'DESC' : 'ASC';
    const key = `${col}|${order}|${foldersOnly}`;
    if (!this.pages.has(key)) {
      // Folders first, like Drive; names break ties.
      this.pages.set(key, this.db.prepare(`SELECT * FROM nodes WHERE owner = ? AND parent = ? AND trash_root IS NULL
        ${foldersOnly ? "AND kind = 'folder'" : ''}
        ORDER BY kind = 'file', ${col} ${order}, name COLLATE NOCASE ${order} LIMIT ? OFFSET ?`));
    }
    const rows = this.pages.get(key).all(user.id, folder.id, PAGE + 1, Math.max(0, offset | 0));
    const crumbs = folder.id ? this.q.chain.all(folder.id).map((c) => ({ id: c.id, name: c.name })) : [];
    return {
      folder: { id: folder.id || 'root', name: folder.name },
      path: crumbs,
      items: rows.slice(0, PAGE).map(item),
      more: rows.length > PAGE,
      total: this.q.count.get(user.id, folder.id).n,
      storage: this.storage(user),
    };
  }

  createFolder(user, parentId, rawName) {
    const parent = this.folder(user, parentId);
    const name = cleanName(rawName);
    if (!name) throw new HttpError(400, 'Give the folder a name');
    const final = this.uniqueName(user, parent.id, name);
    fs.mkdirSync(path.join(this.diskPath(user, parent.id), final), { recursive: true });
    const now = Date.now();
    const id = newId();
    this.q.insert.run(id, user.id, parent.id, final, 'folder', 0, '', now, now);
    return this.q.get.get(id, user.id);
  }

  // Finds or makes each folder in "a/b/c" under parentId; for folder uploads.
  // Runs synchronously, so uploads arriving together can't make a folder twice.
  ensurePath(user, parentId, relDir) {
    let parent = this.folder(user, parentId).id;
    for (const part of String(relDir).split('/').map(cleanName).filter(Boolean).slice(0, 64)) {
      const found = this.q.findFolder.get(user.id, parent, part);
      parent = found ? found.id : this.createFolder(user, parent, part).id;
    }
    return parent;
  }

  rename(user, id, rawName) {
    const n = this.node(user, id);
    const name = cleanName(rawName);
    if (!name) throw new HttpError(400, 'Names can’t be empty');
    if (name === n.name) return n;
    const final = name.toLowerCase() === n.name.toLowerCase() ? name : this.uniqueName(user, n.parent, name, n.id);
    const from = this.diskPath(user, n.id);
    fs.renameSync(from, path.join(path.dirname(from), final));
    this.q.rename.run(final, Date.now(), n.id);
    return this.q.get.get(n.id, user.id);
  }

  move(user, ids, parentId) {
    const target = this.folder(user, parentId);
    const above = new Set(target.id ? this.q.chain.all(target.id).map((c) => c.id) : []);
    const moved = [];
    for (const id of ids) {
      const n = this.node(user, id);
      if (n.parent === target.id) continue;
      if (above.has(n.id)) throw new HttpError(400, `Can’t move “${n.name}” into itself`);
      const name = this.uniqueName(user, target.id, n.name);
      fs.renameSync(this.diskPath(user, n.id), path.join(this.diskPath(user, target.id), name));
      this.q.move.run(target.id, name, n.id);
      moved.push({ ...item(n), name, from: n.parent || 'root' });
    }
    return moved;
  }

  async copy(user, ids) {
    const files = ids.map((id) => this.node(user, id, 'file'));
    this.checkSpace(user, files.reduce((a, f) => a + f.size, 0));
    const out = [];
    for (const f of files) {
      const name = this.uniqueName(user, f.parent, `Copy of ${f.name}`);
      const dest = path.join(this.diskPath(user, f.parent), name);
      // The row goes in first so nothing else can take the name while the data copies.
      const now = Date.now();
      const id = newId();
      this.q.insert.run(id, user.id, f.parent, name, 'file', f.size, f.mime, now, now);
      try {
        // On drives that support it, a clone shares the data until either copy changes.
        await fsp.copyFile(this.diskPath(user, f.id), dest, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
      } catch (err) {
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        throw err;
      }
      out.push(item(this.q.get.get(id, user.id)));
    }
    this.changed(user);
    return out;
  }

  // ---------- trash ----------

  trash(user, ids) {
    const done = [];
    const now = Date.now();
    for (const id of ids) {
      const n = this.q.get.get(id, user.id);
      // Already gone, or inside a folder trashed a moment ago: nothing to do.
      if (!n || n.trash_root != null) continue;
      const from = this.diskPath(user, n.id);
      const bin = path.join(this.home(user), 'trash', n.id);
      fs.mkdirSync(bin, { recursive: true });
      fs.renameSync(from, path.join(bin, n.name));
      this.q.trash.run(n.id, n.id);
      this.q.markTrashed.run(now, n.id);
      done.push(n.id);
    }
    return done;
  }

  listTrash(user) {
    return this.q.trashList.all(user.id).map((n) => ({
      ...item(n),
      trashed: n.trashed,
      deletesAt: n.trashed + TRASH_DAYS * DAY,
    }));
  }

  restore(user, ids) {
    const restored = [];
    for (const id of ids) {
      const n = this.q.get.get(id, user.id);
      if (!n || n.trashed == null) continue;
      // Back where it was, or to My Drive if that folder is gone.
      let parent = n.parent;
      if (parent) {
        const p = this.q.get.get(parent, user.id);
        if (!p || p.trash_root != null) parent = '';
      }
      const from = this.diskPath(user, n.id);
      const name = this.uniqueName(user, parent, n.name);
      fs.renameSync(from, path.join(this.diskPath(user, parent), name));
      fs.rmSync(path.join(this.home(user), 'trash', n.id), { recursive: true, force: true });
      this.q.restoreRoot.run(parent, name, n.id);
      this.q.restore.run(n.id);
      restored.push({ ...item(n), name, parent: parent || 'root' });
    }
    return restored;
  }

  async deleteForever(user, ids) {
    const roots = ids
      ? ids.map((id) => this.q.get.get(id, user.id)).filter((n) => n && n.trashed != null)
      : this.q.trashList.all(user.id);
    for (const n of roots) await this.forget(user, n.id);
    if (roots.length) this.changed(user);
    return roots.map((n) => n.id);
  }

  async forget(user, id) {
    await fsp.rm(path.join(this.home(user), 'trash', id), { recursive: true, force: true });
    this.q.forget.run(id);
  }

  // Empties trash older than 30 days and uploads abandoned for a day.
  async sweep(now = Date.now()) {
    const touched = new Set();
    for (const { id, owner } of this.q.expired.all(now - TRASH_DAYS * DAY)) {
      const user = this.users(owner);
      if (!user) continue;
      await this.forget(user, id);
      touched.add(user);
    }
    for (const { id, owner } of this.q.staleUploads.all(now - UPLOAD_TTL)) {
      const user = this.users(owner);
      if (user) await fsp.rm(this.uploadPath(user, id), { force: true });
      this.q.dropUpload.run(id);
    }
    for (const user of touched) this.changed(user);
  }

  // Tells Roost what everyone stores in Nest, at startup.
  syncUsage() {
    for (const { owner } of this.q.owners.all()) {
      const user = this.users(owner);
      if (user) this.changed(user);
    }
  }

  // ---------- uploads ----------

  startUpload(user, body) {
    const size = body.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Bad file size');
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Bad file name');
    let parent = this.folder(user, body.parent).id;
    if (body.path) parent = this.ensurePath(user, parent, str(body.path, 4000));
    this.checkSpace(user, size);
    const mime = str(body.type, 100);
    const id = newId();
    this.q.addUpload.run(id, user.id, parent, name, size, mime, Date.now());
    fs.mkdirSync(path.dirname(this.uploadPath(user, id)), { recursive: true });
    fs.writeFileSync(this.uploadPath(user, id), '');
    if (size === 0) return { id, done: true, item: this.finishUpload(user, this.q.upload.get(id, user.id)) };
    return { id, chunkSize: CHUNK, received: 0 };
  }

  async putChunk(user, id, offset, req) {
    const up = this.q.upload.get(id, user.id);
    if (!up) throw new HttpError(404, 'That upload has expired, try again');
    if (this.busy.has(id)) throw new HttpError(409, 'Already receiving this upload');
    if (offset !== up.received) return { received: up.received, resend: true };
    const part = this.uploadPath(user, id);
    const max = Math.min(CHUNK, up.size - up.received);
    this.busy.add(id);
    const ws = fs.createWriteStream(part, { flags: 'a' });
    let n = 0;
    try {
      for await (const chunk of req) {
        n += chunk.length;
        if (n > max) throw new HttpError(413, 'Upload piece too large');
        if (!ws.write(chunk)) await once(ws, 'drain');
      }
    } finally {
      await new Promise((r) => ws.end(r));
      // Whatever reached the disk counts, so a dropped connection resumes from there.
      const received = Math.min(fs.statSync(part).size, up.size);
      this.q.setReceived.run(received, id);
      this.busy.delete(id);
    }
    const now = this.q.upload.get(id, user.id);
    if (now.received < now.size) return { received: now.received };
    return { received: now.received, done: true, item: this.finishUpload(user, now) };
  }

  finishUpload(user, up) {
    let parent = up.parent;
    if (parent) {
      const p = this.q.get.get(parent, user.id);
      if (!p || p.trash_root != null) parent = '';
    }
    const name = this.uniqueName(user, parent, up.name);
    const dest = path.join(this.diskPath(user, parent), name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(this.uploadPath(user, up.id), dest);
    const now = Date.now();
    const id = newId();
    this.q.insert.run(id, user.id, parent, name, 'file', up.size, up.mime, now, now);
    this.q.dropUpload.run(up.id);
    this.changed(user);
    return item(this.q.get.get(id, user.id));
  }

  cancelUpload(user, id) {
    const up = this.q.upload.get(id, user.id);
    if (!up || this.busy.has(id)) return;
    fs.rmSync(this.uploadPath(user, id), { force: true });
    this.q.dropUpload.run(id);
  }

  // ---------- downloads ----------

  // inline: a photo or video type to show in the page instead of downloading
  // (Glint passes it only for types a browser can't run as a page).
  async download(user, id, req, res, { inline = '' } = {}) {
    const n = this.node(user, id, 'file');
    const file = this.diskPath(user, n.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'That file is missing from the drive');
    }
    const headers = {
      'Content-Type': inline || 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : disposition(n.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
    };
    if (inline) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    // One byte range, so interrupted downloads can carry on.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = stat.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !stat.size) return res.end();
    await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }

  async downloadZip(user, ids, res) {
    const entries = [];
    for (const id of ids) {
      const n = this.node(user, id);
      const base = path.dirname(this.diskPath(user, n.id));
      for (const d of this.q.tree.all(n.id)) {
        entries.push(d.kind === 'folder'
          ? { name: `${d.rel}/`, file: null, mtime: d.modified }
          : { name: d.rel, file: path.join(base, ...d.rel.split('/')), size: d.size, mtime: d.modified });
      }
    }
    const p = zip.plan(entries);
    const first = this.q.get.get(ids[0], user.id);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition(ids.length === 1 ? `${first.name}.zip` : 'Nest files.zip'),
      'Content-Length': p.total,
      'Cache-Control': 'no-store',
    });
    try {
      await zip.streamZip(res, p);
    } catch (err) {
      console.error('Zip download stopped:', err.message);
      res.destroy();
    }
  }

  // ---------- HTTP ----------

  async handle(req, res, user, pathname, params) {
    const m = (re) => re.exec(pathname);
    const method = req.method;
    let r;

    if (method === 'GET' && (r = m(/^\/api\/nest\/folders\/([\w-]+)$/))) {
      return send(res, 200, this.list(user, r[1], {
        sort: params.get('sort'),
        dir: params.get('dir'),
        offset: Number(params.get('offset')) || 0,
        foldersOnly: params.get('folders') === '1',
      }));
    }
    if (method === 'POST' && pathname === '/api/nest/folders') {
      const body = await readJson(req);
      // With a path ("a/b"), finds or makes each folder; for empty folders in folder uploads.
      if (body.path) return send(res, 201, { id: this.ensurePath(user, body.parent, str(body.path, 4000)) });
      const n = this.createFolder(user, body.parent, body.name);
      return send(res, 201, { item: item(n) });
    }
    if (method === 'PATCH' && (r = m(/^\/api\/nest\/items\/([\w-]+)$/))) {
      const body = await readJson(req);
      return send(res, 200, { item: item(this.rename(user, r[1], body.name)) });
    }
    if (method === 'POST' && pathname === '/api/nest/move') {
      const body = await readJson(req);
      return send(res, 200, { moved: this.move(user, idList(body.ids), body.parent) });
    }
    if (method === 'POST' && pathname === '/api/nest/copy') {
      const body = await readJson(req);
      return send(res, 201, { items: await this.copy(user, idList(body.ids)) });
    }
    if (method === 'POST' && pathname === '/api/nest/trash') {
      const body = await readJson(req);
      return send(res, 200, { trashed: this.trash(user, idList(body.ids)) });
    }
    if (method === 'GET' && pathname === '/api/nest/trash') {
      return send(res, 200, { items: this.listTrash(user), storage: this.storage(user), days: TRASH_DAYS });
    }
    if (method === 'POST' && pathname === '/api/nest/restore') {
      const body = await readJson(req);
      return send(res, 200, { restored: this.restore(user, idList(body.ids)) });
    }
    if (method === 'POST' && pathname === '/api/nest/trash/delete') {
      const body = await readJson(req);
      const ids = body.all === true ? null : idList(body.ids);
      return send(res, 200, { deleted: await this.deleteForever(user, ids), storage: this.storage(user) });
    }
    if ((method === 'GET' || method === 'HEAD') && (r = m(/^\/api\/nest\/files\/([\w-]+)$/))) {
      return this.download(user, r[1], req, res);
    }
    if (method === 'GET' && pathname === '/api/nest/zip') {
      const ids = idList(String(params.get('ids') || '').split(',').filter(Boolean));
      return this.downloadZip(user, ids, res);
    }
    if (method === 'POST' && pathname === '/api/nest/uploads') {
      const body = await readJson(req, 16 * 1024);
      return send(res, 201, this.startUpload(user, body));
    }
    if (method === 'PUT' && (r = m(/^\/api\/nest\/uploads\/([\w-]+)$/))) {
      const offset = Number(params.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Bad offset');
      const out = await this.putChunk(user, r[1], offset, req);
      return send(res, out.resend ? 409 : 200, out);
    }
    if (method === 'DELETE' && (r = m(/^\/api\/nest\/uploads\/([\w-]+)$/))) {
      this.cancelUpload(user, r[1]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  }
}

function gbText(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

module.exports = { Nest, cleanName, CHUNK, PAGE, TRASH_DAYS };
