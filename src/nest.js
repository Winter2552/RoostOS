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
const { hashPassword, verifyPassword, RateLimiter } = require('./auth');

const CHUNK = 16 * 1024 * 1024; // upload piece size: small enough to retry cheaply
const PAGE = 200; // items per folder page
const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_TTL = DAY; // unfinished uploads are dropped after a day
const DISK_RESERVE = 1024 ** 3; // always leave 1 GB free on the drive
const MAX_IDS = 1000;
const MAX_LINKS = 200; // live public links per person
const LINK_DAYS = 30; // the longest a public link may last (there is no "never")
// Types a browser can show without running anything; the rest only download.
const VIEWABLE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};

// What the viewer can show in the page: a type a browser runs without scripts.
// Text is always sent as plain text, so a .html file shows its source.
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml', 'ini', 'conf', 'toml',
  'js', 'mjs', 'ts', 'css', 'html', 'htm', 'py', 'sh', 'bat', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'php', 'rb', 'sql'];
function viewOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (VIEWABLE[ext]) return { kind: VIEWABLE[ext].split('/')[0], type: VIEWABLE[ext] };
  if (ext === 'pdf') return { kind: 'pdf', type: 'application/pdf' };
  if (TEXT_EXT.includes(ext)) return { kind: 'text', type: 'text/plain; charset=utf-8' };
  return null;
}

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
  CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,         -- the secret in the link
    owner TEXT NOT NULL,
    node TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    pass TEXT,                      -- scrypt hash when the link has a password
    downloads INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS shares_node ON shares (owner, node);
  CREATE TABLE IF NOT EXISTS node_info (
    id TEXT PRIMARY KEY,            -- the file it describes
    owner TEXT NOT NULL,
    data TEXT NOT NULL              -- JSON kept from Google's info file (src/file-info.js)
  );
  CREATE TRIGGER IF NOT EXISTS node_info_gone AFTER DELETE ON nodes BEGIN
    DELETE FROM node_info WHERE id = OLD.id;
  END;
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
  // Public links also take: publicOn() (the admin switch), baseUrl(req) (the
  // address links start with) and audit(req, type, user, detail) (the activity log).
  constructor({ dir, dbFile, users, limitOf, onUsage, publicOn, baseUrl, audit, isSecure }) {
    this.dir = dir;
    this.publicOn = publicOn || (() => true);
    this.baseUrl = baseUrl || ((req) => `http://${req.headers.host}`);
    this.audit = audit || (() => {});
    this.isSecure = isSecure || (() => false);
    // Only failures count (a bad token or password), per visitor address.
    this.guesses = new RateLimiter(20, 5 * 60 * 1000);
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
      setInfo: q('INSERT OR REPLACE INTO node_info (id, owner, data) VALUES (?, ?, ?)'),
      keepInfo: q('INSERT OR IGNORE INTO node_info (id, owner, data) VALUES (?, ?, ?)'),
      info: q('SELECT data FROM node_info WHERE id = ? AND owner = ?'),
      copyInfo: q('INSERT OR REPLACE INTO node_info (id, owner, data) SELECT ?, owner, data FROM node_info WHERE id = ?'),
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
      addShare: q('INSERT INTO shares (token, owner, node, created, expires, pass) VALUES (?, ?, ?, ?, ?, ?)'),
      shareCount: q('SELECT COUNT(*) AS n FROM shares WHERE owner = ? AND expires > ?'),
      sharesOf: q('SELECT * FROM shares WHERE owner = ? AND node = ? AND expires > ? ORDER BY created DESC'),
      dropShare: q('DELETE FROM shares WHERE token = ? AND owner = ?'),
      share: q('SELECT * FROM shares WHERE token = ?'),
      countShare: q('UPDATE shares SET downloads = downloads + 1 WHERE token = ?'),
      pruneShares: q('DELETE FROM shares WHERE expires < ? OR node NOT IN (SELECT id FROM nodes)'),
    };
    this.pages = new Map();
    this.finds = new Map();
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
        throw new HttpError(413, `Not enough space: ${gbText(Math.max(0, left))} left of your ${gbText(limitBytes)}`, 'over-limit');
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

  // ---------- search ----------

  // Items (not in the trash) whose names hold every word typed, in any case.
  // Names starting with the first word come first, then the newest.
  search(user, q, limit = 20) {
    const words = String(q).split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return { items: [], more: false };
    if (!this.finds.has(words.length)) {
      this.finds.set(words.length, this.db.prepare(`SELECT * FROM nodes WHERE owner = ? AND trash_root IS NULL
        ${words.map(() => "AND name LIKE ? ESCAPE '\\'").join(' ')}
        ORDER BY name LIKE ? ESCAPE '\\' DESC, modified DESC LIMIT ?`));
    }
    const like = (w) => w.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.finds.get(words.length).all(user.id, ...words.map((w) => `%${like(w)}%`), `${like(words[0])}%`, limit + 1);
    const places = new Map();
    const where = (parent) => {
      if (!places.has(parent)) places.set(parent, ['My Drive', ...(parent ? this.q.chain.all(parent).map((c) => c.name) : [])].join(' / '));
      return places.get(parent);
    };
    return {
      items: rows.slice(0, limit).map((n) => ({ ...item(n), parent: n.parent || 'root', where: where(n.parent) })),
      more: rows.length > limit,
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

  // Puts files that come from outside Nest (a backup) into a new folder at the
  // top of the user's drive. Nothing already in Nest is touched: the folder
  // gets a free name, and everything goes inside it.
  //   files: [{ rel: 'a/b.txt', size, mtime, open() }], open() returns a stream.
  // Stops before starting if it wouldn't fit the user's limit or the drive.
  async importFolder(user, folderName, files, { onFile } = {}) {
    this.checkSpace(user, files.reduce((a, f) => a + f.size, 0));
    const top = this.createFolder(user, '', folderName);
    let restored = 0;
    for (const f of files) {
      const slash = f.rel.lastIndexOf('/');
      const parent = slash < 0 ? top.id : this.ensurePath(user, top.id, f.rel.slice(0, slash));
      const name = this.uniqueName(user, parent, cleanName(f.rel.slice(slash + 1)) || 'file');
      const dir = this.diskPath(user, parent);
      const temp = this.uploadPath(user, `restore-${newId()}`);
      fs.mkdirSync(path.dirname(temp), { recursive: true });
      try {
        await pipeline(f.open(), fs.createWriteStream(temp, { flags: 'wx' }));
        const size = fs.statSync(temp).size;
        const when = new Date(f.mtime);
        fs.utimesSync(temp, when, when);
        fs.renameSync(temp, path.join(dir, name));
        const id = newId();
        this.q.insert.run(id, user.id, parent, name, 'file', size, '', Date.now(), f.mtime);
      } catch (err) {
        fs.rmSync(temp, { force: true });
        this.changed(user);
        throw err;
      }
      restored++;
      if (onFile) onFile(f, restored);
    }
    this.changed(user);
    return top;
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
      this.q.copyInfo.run(id, f.id);
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
    this.q.pruneShares.run(now);
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

  // ---------- file info ----------

  // data: details from src/file-info.js. Only fills a file that has none yet,
  // unless replace is set.
  setInfo(user, id, data, replace = false) {
    (replace ? this.q.setInfo : this.q.keepInfo).run(id, user.id, JSON.stringify(data));
  }

  // What Info shows: the basics every item has, plus Google's details if kept.
  info(user, id) {
    const n = this.node(user, id);
    const row = this.q.info.get(n.id, user.id);
    let google = null;
    try { google = row ? JSON.parse(row.data) : null; } catch { /* unreadable: show the basics only */ }
    const where = this.q.chain.all(n.id).slice(0, -1).map((c) => c.name);
    return {
      id: n.id, name: n.name, kind: n.kind, size: n.size, mime: n.mime,
      created: n.created, modified: n.modified,
      where: [user.id === 'family' ? 'Family' : 'My Drive', ...where],
      google,
    };
  }

  // ---------- downloads ----------

  // inline: a photo or video type to show in the page instead of downloading
  // (Glint passes it only for types a browser can't run as a page).
  async download(user, id, req, res, { inline = '', csp = '' } = {}) {
    const n = this.node(user, id, 'file');
    const file = this.diskPath(user, n.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'That file is missing from the drive');
    }
    // A device that already has this exact file gets a tiny "not changed"
    // instead of the whole file again: saves home upload when you're away.
    const etag = `"${n.id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = {
      'Content-Type': inline || 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : disposition(n.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    };
    if (inline) headers['Content-Security-Policy'] = csp || "default-src 'none'; sandbox";
    if (csp) headers['X-Frame-Options'] = 'SAMEORIGIN'; // lets Nest's viewer show a PDF in a frame
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    // One byte range, so interrupted downloads can carry on.
    // A resumed download of a file that has since changed starts over.
    const ifRange = req.headers['if-range'];
    const range = ifRange && ifRange !== etag ? null : /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
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

  // ---------- public links ----------

  // A link opens one file for anyone who has it, no sign-in. It stops when it
  // expires, is removed, or the file goes to the trash or is deleted.
  createShare(user, id, { days, password } = {}) {
    if (!this.publicOn()) throw new HttpError(403, 'The admin has turned off public links');
    const n = this.node(user, id, 'file');
    const now = Date.now();
    if (this.q.shareCount.get(user.id, now).n >= MAX_LINKS) throw new HttpError(400, 'Too many links; remove some first');
    const d = Math.min(LINK_DAYS, Math.max(1, Math.floor(Number(days)) || 7));
    const pass = typeof password === 'string' && password ? password.slice(0, 100) : '';
    if (pass && pass.length < 4) throw new HttpError(400, 'Use at least 4 characters for the password');
    const token = crypto.randomBytes(24).toString('base64url');
    this.q.addShare.run(token, user.id, n.id, now, now + d * DAY, pass ? hashPassword(pass) : null);
    return this.shareView({ token, expires: now + d * DAY, pass, downloads: 0, created: now });
  }

  shareView(s, req) {
    return {
      token: s.token,
      url: req ? `${this.baseUrl(req)}/s/${s.token}` : undefined,
      expires: s.expires,
      password: Boolean(s.pass),
      downloads: s.downloads,
      created: s.created,
    };
  }

  listShares(user, id, req) {
    this.node(user, id, 'file');
    return this.q.sharesOf.all(user.id, id, Date.now()).map((s) => this.shareView(s, req));
  }

  removeShare(user, token) {
    this.q.dropShare.run(token, user.id);
  }

  // The link's file if the link still works, else null.
  liveShare(token) {
    const s = /^[\w-]{20,64}$/.test(token) ? this.q.share.get(token) : null;
    if (!s || s.expires <= Date.now()) return null;
    const n = this.q.get.get(s.node, s.owner);
    const owner = this.users(s.owner);
    if (!n || n.kind !== 'file' || n.trash_root != null || !owner) return null;
    return { s, n, owner };
  }

  // What a visitor's cookie must hold after they type a link's password.
  unlockValue(s) {
    return crypto.createHash('sha256').update(`${s.pass}:${s.token}`).digest('hex');
  }

  unlocked(req, s) {
    if (!s.pass) return true;
    const m = new RegExp(`(?:^|; )rs_${s.token.slice(0, 12)}=([0-9a-f]{64})`).exec(req.headers.cookie || '');
    const want = Buffer.from(this.unlockValue(s));
    return Boolean(m) && crypto.timingSafeEqual(Buffer.from(m[1]), want);
  }

  // The pages and files behind /s/<token>. `ip` is the visitor's address.
  async publicHandle(req, res, pathname, ip) {
    const gone = (code, text) => {
      this.guesses.fail(ip);
      return page(res, code, 'Link not available', `<p class="muted">${text}</p>`);
    };
    if (!this.publicOn()) return page(res, 404, 'Links are off', '<p class="muted">Public links are turned off on this Roost.</p>');
    if (!this.guesses.allow(ip)) return page(res, 429, 'Slow down', '<p class="muted">Too many tries. Wait a few minutes.</p>');
    const r = /^\/s\/([\w-]+)(?:\/(file|view))?$/.exec(pathname);
    if (!r || !['GET', 'HEAD', 'POST'].includes(req.method)) throw new HttpError(404, 'Not found');
    const live = this.liveShare(r[1]);
    if (!live) return gone(404, 'This link has expired, was removed, or never existed.');
    const { s, n, owner } = live;
    const base = `/s/${s.token}`;
    const ext = path.extname(n.name).slice(1).toLowerCase();
    const viewType = VIEWABLE[ext] || '';

    if (req.method === 'POST' && !r[2]) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) throw new HttpError(413, 'Body too large');
      }
      const given = new URLSearchParams(body).get('password') || '';
      if (!s.pass || !verifyPassword(given, s.pass)) {
        this.guesses.fail(ip);
        return page(res, 401, n.name, passwordForm(base, 'That password isn’t right.'));
      }
      res.writeHead(303, {
        Location: base,
        'Set-Cookie': `rs_${s.token.slice(0, 12)}=${this.unlockValue(s)}; Path=${base}; Max-Age=21600; HttpOnly; SameSite=Lax${this.isSecure(req) ? '; Secure' : ''}`,
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    if (req.method === 'POST') throw new HttpError(405, 'Method not allowed');

    if (!this.unlocked(req, s)) return page(res, 401, n.name, passwordForm(base, ''));

    if (r[2]) {
      if (r[2] === 'view' && !viewType) throw new HttpError(404, 'Not found');
      if (!req.headers.range && req.method === 'GET') this.q.countShare.run(s.token);
      return this.download(owner, n.id, req, res, r[2] === 'view' ? { inline: viewType } : {});
    }
    const shown = viewType.startsWith('image/') ? `<img src="${base}/view" alt="">`
      : viewType.startsWith('video/') ? `<video src="${base}/view" controls playsinline preload="metadata"></video>`
      : viewType.startsWith('audio/') ? `<audio src="${base}/view" controls preload="none"></audio>` : '';
    const left = Math.max(1, Math.ceil((s.expires - Date.now()) / DAY));
    return page(res, 200, n.name, `${shown}
      <p class="muted">${gbText(n.size)} · link works for ${left} more day${left === 1 ? '' : 's'}</p>
      <p><a class="btn" href="${base}/file" download>Download</a></p>`, { media: Boolean(shown) });
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
    // Move to Nest (src/nest-import.js).
    if (method === 'GET' && pathname === '/api/nest/import') {
      return send(res, 200, this.importer.status(user));
    }
    if (method === 'POST' && pathname === '/api/nest/import/start') {
      const body = await readJson(req, 1024);
      return send(res, 200, this.importer.start(user, { deleteZips: body.deleteZips === true }));
    }
    if (method === 'POST' && pathname === '/api/nest/import/stop') {
      return send(res, 200, this.importer.stop(user));
    }
    if (method === 'POST' && pathname === '/api/nest/import/tidy') {
      const body = await readJson(req);
      return send(res, 200, { tidy: await this.importer.tidy(user, body.apply === true) });
    }
    if (method === 'POST' && pathname === '/api/nest/import/delete-zips') {
      return send(res, 200, await this.importer.deleteZips(user));
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
      if (params.get('view') === '1') {
        const n = this.node(user, r[1], 'file');
        const v = viewOf(n.name);
        if (!v) throw new HttpError(404, 'This kind of file can’t be shown here');
        return this.download(user, n.id, req, res, { inline: v.type, csp: v.kind === 'pdf' ? "default-src 'none'; frame-ancestors 'self'" : '' });
      }
      return this.download(user, r[1], req, res);
    }
    if (method === 'GET' && (r = m(/^\/api\/nest\/items\/([\w-]+)\/info$/))) {
      return send(res, 200, { info: this.info(user, r[1]) });
    }
    if (method === 'GET' && pathname === '/api/nest/zip') {
      const ids = idList(String(params.get('ids') || '').split(',').filter(Boolean));
      return this.downloadZip(user, ids, res);
    }
    if (method === 'POST' && pathname === '/api/nest/shares') {
      const body = await readJson(req);
      const link = this.createShare(user, body.id, body);
      this.audit(req, 'share-created', user, this.q.get.get(body.id, user.id).name);
      return send(res, 201, { share: { ...link, url: `${this.baseUrl(req)}/s/${link.token}` } });
    }
    if (method === 'GET' && pathname === '/api/nest/shares') {
      return send(res, 200, { shares: this.listShares(user, params.get('id'), req), enabled: this.publicOn() });
    }
    if (method === 'DELETE' && (r = m(/^\/api\/nest\/shares\/([\w-]+)$/))) {
      this.removeShare(user, r[1]);
      this.audit(req, 'share-removed', user, '');
      return send(res, 200, { ok: true });
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

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function passwordForm(base, error) {
  return `<p class="muted">This file needs a password.</p>${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="${base}"><input type="password" name="password" aria-label="Password" autocomplete="off" autofocus required>
    <button class="btn" type="submit">Open</button></form>`;
}

// The small page a link opens: plain black and white, no scripts.
function page(res, status, title, body, { media = false } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px system-ui,sans-serif}
main{width:min(92vw,560px);padding:24px 0;text-align:center}h1{font-size:20px;word-break:break-word}
img,video{max-width:100%;max-height:60vh;border-radius:8px}.muted{color:#999}.err{color:#f66}
.btn{display:inline-block;background:#fff;color:#000;border:0;border-radius:8px;padding:12px 22px;font:inherit;text-decoration:none;cursor:pointer}
input{padding:12px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font:inherit;margin-right:8px;max-width:60%}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${media ? "; img-src 'self'; media-src 'self'" : ''}`,
  });
  res.end(html);
}

function gbText(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

module.exports = { Nest, cleanName, disposition, CHUNK, PAGE, TRASH_DAYS };
