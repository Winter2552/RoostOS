'use strict';

// Glint: Roost's photo library, built on Nest's storage.
//
// Photos and videos are ordinary Nest files, so they share the user's storage
// limit, the trash and downloads, and stay readable on the drive without
// Roost. Glint uploads go to My Drive/Photos/<year>, and every photo or video
// anywhere in a user's Nest shows up in the timeline.
//
// The server does no image work. The browser that uploads a photo (or the
// first one to show an older photo) reads its date, draws a small preview and
// sends both back; Glint just keeps them. What Glint adds on top of Nest
// lives in the same SQLite file:
//   photos        date taken, size in pixels, preview, favourite
//   albums        named sets of photos
//   album_photos  which photos are in which album
// Previews are small JPEGs in <user's Nest folder>/.glint/<photo id>.jpg.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { HttpError, send, readJson, str } = require('./http');

const PAGE = 240; // photos per timeline page
const THUMB_MAX = 512 * 1024; // previews are about 30 KB; this is a ceiling
const MAX_IDS = 1000;
const THUMB_NONE = 2; // the browser couldn't draw one (e.g. HEIC on Windows)

// What counts as a photo or video: by type, or by name when the browser sent no type.
const MEDIA_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'mp4', 'mov', 'm4v', 'webm', '3gp'];
const MEDIA = `n.kind = 'file' AND n.mime != 'image/svg+xml' AND (n.mime LIKE 'image/%' OR n.mime LIKE 'video/%' OR ${
  MEDIA_EXT.map((e) => `lower(n.name) LIKE '%.${e}'`).join(' OR ')})`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,               -- the Nest file
    owner TEXT NOT NULL,
    taken INTEGER NOT NULL,            -- ms; the upload time until the browser reads the real date
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,  -- seconds, for videos
    thumb INTEGER NOT NULL DEFAULT 0,  -- 0 not yet, 1 made, 2 couldn't be made
    fav INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS photos_taken ON photos (owner, taken DESC, id DESC);
  CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    created INTEGER NOT NULL,
    modified INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS albums_owner ON albums (owner);
  CREATE TABLE IF NOT EXISTS album_photos (
    album TEXT NOT NULL,
    photo TEXT NOT NULL,
    added INTEGER NOT NULL,
    PRIMARY KEY (album, photo)
  );
  CREATE INDEX IF NOT EXISTS album_photos_photo ON album_photos (photo);
  CREATE INDEX IF NOT EXISTS nodes_size ON nodes (owner, size);
`;

// Image and video types a browser can show directly. Anything else is sent
// as a download, so an uploaded web page can never run as part of Roost.
const INLINE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif|bmp)|video\/(mp4|quicktime|webm|x-m4v|3gpp))$/;
const BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime',
  webm: 'video/webm', '3gp': 'video/3gpp',
};

function mediaType(n) {
  if (INLINE.test(n.mime)) return n.mime;
  const ext = n.name.slice(n.name.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXT[ext] || '';
}

function idList(v) {
  if (!Array.isArray(v) || !v.length || v.length > MAX_IDS || !v.every((x) => typeof x === 'string')) {
    throw new HttpError(400, 'Pick at least one photo');
  }
  return [...new Set(v)];
}

function num(v, min, max) {
  if (v === null || v === undefined || v === '') return null; // Number(null) is 0, which is a real date
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const YEAR_MIN = 1900;
const YEAR_MAX = 2200;
// Dates before 1970 (scanned old photos) are allowed; nothing past 2200.
const TAKEN_MIN = Date.UTC(YEAR_MIN, 0, 1);
const TAKEN_MAX = Date.UTC(YEAR_MAX, 0, 1);

class Glint {
  constructor({ nest }) {
    this.nest = nest;
    this.db = nest.db;
    this.db.exec(SCHEMA);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      // New photos in Nest since last time, dated by when they arrived until a browser reads the real date.
      index: q(`INSERT INTO photos (id, owner, taken)
                SELECT n.id, n.owner, n.created FROM nodes n
                WHERE n.owner = ? AND n.trash_root IS NULL AND ${MEDIA}
                AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.id = n.id)`),
      indexOne: q(`INSERT OR IGNORE INTO photos (id, owner, taken)
                   SELECT n.id, n.owner, n.created FROM nodes n
                   WHERE n.id = ? AND n.owner = ? AND n.trash_root IS NULL AND ${MEDIA}`),
      photo: q(`SELECT p.*, n.name, n.mime, n.size FROM photos p JOIN nodes n ON n.id = p.id
                WHERE p.id = ? AND p.owner = ? AND n.trash_root IS NULL`),
      describe: q('UPDATE photos SET taken = ?, width = ?, height = ?, duration = ?, thumb = ? WHERE id = ?'),
      fav: q('UPDATE photos SET fav = ? WHERE id = ? AND owner = ?'),
      count: q(`SELECT COUNT(*) AS n FROM photos p JOIN nodes n ON n.id = p.id
                WHERE p.owner = ? AND n.trash_root IS NULL`),
      // Same name and size as a photo already in Nest: the duplicate check.
      same: q(`SELECT 1 FROM nodes n WHERE n.owner = ? AND n.size = ? AND n.kind = 'file'
               AND n.trash_root IS NULL AND n.name = ? COLLATE NOCASE LIMIT 1`),
      orphans: q('SELECT p.id, p.owner FROM photos p WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = p.id) LIMIT 1000'),
      dropPhoto: q('DELETE FROM photos WHERE id = ?'),
      dropFromAlbums: q('DELETE FROM album_photos WHERE photo = ?'),
      albums: q(`SELECT a.*, COUNT(n.id) AS count,
                   (SELECT ap2.photo FROM album_photos ap2 JOIN nodes n2 ON n2.id = ap2.photo
                    JOIN photos p2 ON p2.id = ap2.photo
                    WHERE ap2.album = a.id AND n2.trash_root IS NULL AND p2.thumb = 1 ORDER BY p2.taken DESC LIMIT 1) AS cover
                 FROM albums a
                 LEFT JOIN album_photos ap ON ap.album = a.id
                 LEFT JOIN nodes n ON n.id = ap.photo AND n.trash_root IS NULL
                 WHERE a.owner = ? GROUP BY a.id ORDER BY a.modified DESC`),
      album: q('SELECT * FROM albums WHERE id = ? AND owner = ?'),
      addAlbum: q('INSERT INTO albums (id, owner, name, created, modified) VALUES (?, ?, ?, ?, ?)'),
      renameAlbum: q('UPDATE albums SET name = ?, modified = ? WHERE id = ?'),
      touchAlbum: q('UPDATE albums SET modified = ? WHERE id = ?'),
      dropAlbum: q('DELETE FROM albums WHERE id = ?'),
      emptyAlbum: q('DELETE FROM album_photos WHERE album = ?'),
      addToAlbum: q('INSERT OR IGNORE INTO album_photos (album, photo, added) VALUES (?, ?, ?)'),
      removeFromAlbum: q('DELETE FROM album_photos WHERE album = ? AND photo = ?'),
    };
    this.pages = new Map();
  }

  thumbPath(user, id) {
    return path.join(this.nest.home(user), '.glint', `${id}.jpg`);
  }

  // ---------- timeline ----------

  // A page of photos, newest first. `before` is the last photo of the
  // previous page ("<taken>.<id>"); album and favourites narrow the list.
  timeline(user, { before = '', album = '', favourites = false } = {}) {
    if (!before) this.q.index.run(user.id);
    if (album && !this.q.album.get(album, user.id)) throw new HttpError(404, 'That album no longer exists');
    const key = `${Boolean(before)}|${Boolean(album)}|${favourites}`;
    if (!this.pages.has(key)) {
      this.pages.set(key, this.db.prepare(`SELECT p.*, n.name, n.mime, n.size FROM photos p
        JOIN nodes n ON n.id = p.id
        ${album ? 'JOIN album_photos ap ON ap.photo = p.id AND ap.album = :album' : ''}
        WHERE p.owner = :owner AND n.trash_root IS NULL
        ${favourites ? 'AND p.fav = 1' : ''}
        ${before ? 'AND (p.taken < :taken OR (p.taken = :taken AND p.id < :id))' : ''}
        ORDER BY p.taken DESC, p.id DESC LIMIT :limit`));
    }
    const params = { owner: user.id, limit: PAGE + 1 };
    if (album) params.album = album;
    if (before) {
      const dot = before.indexOf('.');
      const taken = Number(before.slice(0, dot));
      if (dot < 1 || !Number.isSafeInteger(taken)) throw new HttpError(400, 'Bad page');
      params.taken = taken;
      params.id = before.slice(dot + 1);
    }
    const rows = this.pages.get(key).all(params);
    const items = rows.slice(0, PAGE).map(photoItem);
    const last = items[items.length - 1];
    return {
      items,
      next: rows.length > PAGE ? `${last.taken}.${last.id}` : null,
      total: before ? undefined : this.q.count.get(user.id).n,
    };
  }

  find(user, id) {
    const p = this.q.photo.get(id, user.id);
    if (p) return p;
    // Just uploaded, or put in Nest since the timeline last loaded.
    return this.q.indexOne.run(id, user.id).changes ? this.q.photo.get(id, user.id) : null;
  }

  photo(user, id) {
    const p = this.find(user, id);
    if (!p) throw new HttpError(404, 'That photo no longer exists');
    return p;
  }

  // The browser read the photo's date and size and drew a preview (body: a
  // JPEG, or empty when it couldn't).
  async describe(user, id, params, req) {
    const p = this.photo(user, id);
    const taken = num(params.get('taken'), TAKEN_MIN, TAKEN_MAX);
    const width = num(params.get('w'), 0, 100000) || 0;
    const height = num(params.get('h'), 0, 100000) || 0;
    const duration = num(params.get('dur'), 0, 100 * 3600) || 0;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > THUMB_MAX) throw new HttpError(413, 'Preview too large');
      chunks.push(chunk);
    }
    const jpeg = Buffer.concat(chunks);
    let thumb = THUMB_NONE;
    if (jpeg.length) {
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'Previews must be JPEG');
      const file = this.thumbPath(user, id);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}`;
      await fsp.writeFile(tmp, jpeg);
      await fsp.rename(tmp, file);
      thumb = 1;
    }
    this.q.describe.run(taken === null ? p.taken : Math.round(taken), Math.round(width), Math.round(height), duration, thumb, id);
    return photoItem(this.photo(user, id));
  }

  async sendThumb(user, id, req, res) {
    this.photo(user, id);
    let data;
    try {
      data = await fsp.readFile(this.thumbPath(user, id));
    } catch {
      throw new HttpError(404, 'No preview yet');
    }
    // A photo's preview never changes (a new upload is a new photo), so the browser keeps it.
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  // Names and sizes the user is about to upload; true for each one already in Nest.
  check(user, files) {
    if (!Array.isArray(files) || files.length > 5000) throw new HttpError(400, 'Too many files at once');
    return files.map((f) => Boolean(f && Number.isSafeInteger(f.size) && typeof f.name === 'string'
      && this.q.same.get(user.id, f.size, f.name.slice(0, 240))));
  }

  favourite(user, ids, on) {
    for (const id of ids) this.q.fav.run(on ? 1 : 0, id, user.id);
    return ids;
  }

  // ---------- trash (Nest's trash, showing only photos and videos) ----------

  listTrash(user) {
    return this.nest.listTrash(user).filter((t) => t.kind === 'file' && mediaType(t));
  }

  trashIds(user, ids) {
    const allowed = new Set(this.listTrash(user).map((t) => t.id));
    return ids.filter((id) => allowed.has(id));
  }

  // ---------- albums ----------

  albums(user) {
    return this.q.albums.all(user.id).map((a) => ({ id: a.id, name: a.name, count: a.count, cover: a.cover, modified: a.modified }));
  }

  album(user, id) {
    const a = this.q.album.get(id, user.id);
    if (!a) throw new HttpError(404, 'That album no longer exists');
    return a;
  }

  albumName(raw) {
    const name = str(raw, 80);
    if (!name) throw new HttpError(400, 'Give the album a name');
    return name;
  }

  createAlbum(user, rawName, ids = []) {
    const now = Date.now();
    const id = crypto.randomBytes(9).toString('base64url');
    this.q.addAlbum.run(id, user.id, this.albumName(rawName), now, now);
    if (ids.length) this.addPhotos(user, id, ids);
    return this.albums(user).find((a) => a.id === id);
  }

  addPhotos(user, albumId, ids) {
    const a = this.album(user, albumId);
    const now = Date.now();
    let added = 0;
    for (const id of ids) {
      if (!this.find(user, id)) continue;
      added += Number(this.q.addToAlbum.run(a.id, id, now).changes);
    }
    this.q.touchAlbum.run(now, a.id);
    return added;
  }

  // ---------- clean-up ----------

  // Photos deleted for good (from Glint or from Nest) lose their row, album
  // places and preview. Runs with Nest's own clean-up.
  async sweep() {
    for (;;) {
      const gone = this.q.orphans.all();
      for (const { id, owner } of gone) {
        const user = this.nest.users(owner);
        if (user) await fsp.rm(this.thumbPath(user, id), { force: true });
        this.q.dropFromAlbums.run(id);
        this.q.dropPhoto.run(id);
      }
      if (gone.length < 1000) return;
    }
  }

  // ---------- HTTP ----------

  async handle(req, res, user, pathname, params) {
    const m = (re) => re.exec(pathname);
    const method = req.method;
    const nest = this.nest;
    let r;

    if (method === 'GET' && pathname === '/api/glint/photos') {
      return send(res, 200, {
        ...this.timeline(user, { before: str(params.get('before'), 80), album: str(params.get('album'), 40), favourites: params.get('fav') === '1' }),
        storage: nest.storage(user),
      });
    }
    if ((method === 'GET' || method === 'HEAD') && (r = m(/^\/api\/glint\/thumbs\/([\w-]+)$/))) {
      return this.sendThumb(user, r[1], req, res);
    }
    if ((method === 'GET' || method === 'HEAD') && (r = m(/^\/api\/glint\/media\/([\w-]+)$/))) {
      const p = this.photo(user, r[1]);
      return nest.download(user, p.id, req, res, { inline: mediaType(p) });
    }
    if ((method === 'GET' || method === 'HEAD') && (r = m(/^\/api\/glint\/download\/([\w-]+)$/))) {
      return nest.download(user, this.photo(user, r[1]).id, req, res);
    }
    if (method === 'GET' && pathname === '/api/glint/zip') {
      const ids = idList(String(params.get('ids') || '').split(',').filter(Boolean));
      for (const id of ids) this.photo(user, id);
      return nest.downloadZip(user, ids, res);
    }
    if (method === 'PUT' && (r = m(/^\/api\/glint\/photos\/([\w-]+)\/preview$/))) {
      return send(res, 200, { item: await this.describe(user, r[1], params, req) });
    }
    if (method === 'POST' && pathname === '/api/glint/favourite') {
      const body = await readJson(req);
      return send(res, 200, { ids: this.favourite(user, idList(body.ids), body.on !== false) });
    }
    if (method === 'POST' && pathname === '/api/glint/check') {
      const body = await readJson(req, 1024 * 1024);
      return send(res, 200, { exists: this.check(user, body.files) });
    }

    // Uploads are Nest uploads into My Drive/Photos/<year>.
    if (method === 'POST' && pathname === '/api/glint/uploads') {
      const body = await readJson(req, 16 * 1024);
      const year = num(body.year, YEAR_MIN, YEAR_MAX - 1);
      const out = nest.startUpload(user, {
        parent: 'root',
        path: `Photos/${year === null ? new Date().getFullYear() : Math.floor(year)}`,
        name: body.name,
        size: body.size,
        type: body.type,
      });
      return send(res, 201, out);
    }
    if (method === 'PUT' && (r = m(/^\/api\/glint\/uploads\/([\w-]+)$/))) {
      const offset = Number(params.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Bad offset');
      const out = await nest.putChunk(user, r[1], offset, req);
      return send(res, out.resend ? 409 : 200, out);
    }
    if (method === 'DELETE' && (r = m(/^\/api\/glint\/uploads\/([\w-]+)$/))) {
      nest.cancelUpload(user, r[1]);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/glint/trash') {
      const body = await readJson(req);
      const ids = idList(body.ids).filter((id) => this.find(user, id));
      return send(res, 200, { trashed: nest.trash(user, ids) });
    }
    if (method === 'GET' && pathname === '/api/glint/trash') {
      return send(res, 200, { items: this.listTrash(user), storage: nest.storage(user) });
    }
    if (method === 'POST' && pathname === '/api/glint/restore') {
      const body = await readJson(req);
      return send(res, 200, { restored: nest.restore(user, this.trashIds(user, idList(body.ids))) });
    }
    if (method === 'POST' && pathname === '/api/glint/trash/delete') {
      const body = await readJson(req);
      const ids = body.all === true ? this.listTrash(user).map((t) => t.id) : this.trashIds(user, idList(body.ids));
      const deleted = ids.length ? await nest.deleteForever(user, ids) : [];
      await this.sweep();
      return send(res, 200, { deleted, storage: nest.storage(user) });
    }

    if (method === 'GET' && pathname === '/api/glint/albums') {
      return send(res, 200, { albums: this.albums(user) });
    }
    if (method === 'POST' && pathname === '/api/glint/albums') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) && body.ids.length ? idList(body.ids) : [];
      return send(res, 201, { album: this.createAlbum(user, body.name, ids) });
    }
    if (method === 'PATCH' && (r = m(/^\/api\/glint\/albums\/([\w-]+)$/))) {
      const a = this.album(user, r[1]);
      const body = await readJson(req);
      this.q.renameAlbum.run(this.albumName(body.name), Date.now(), a.id);
      return send(res, 200, { album: this.albums(user).find((x) => x.id === a.id) });
    }
    if (method === 'DELETE' && (r = m(/^\/api\/glint\/albums\/([\w-]+)$/))) {
      // Deleting an album keeps its photos.
      const a = this.album(user, r[1]);
      this.q.emptyAlbum.run(a.id);
      this.q.dropAlbum.run(a.id);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && (r = m(/^\/api\/glint\/albums\/([\w-]+)\/(add|remove)$/))) {
      const a = this.album(user, r[1]);
      const body = await readJson(req);
      const ids = idList(body.ids);
      if (r[2] === 'add') return send(res, 200, { added: this.addPhotos(user, a.id, ids) });
      for (const id of ids) this.q.removeFromAlbum.run(a.id, id);
      this.q.touchAlbum.run(Date.now(), a.id);
      return send(res, 200, { removed: ids.length });
    }
    throw new HttpError(404, 'Not found');
  }
}

function photoItem(p) {
  return {
    id: p.id,
    name: p.name,
    size: p.size,
    video: (mediaType(p) || p.mime).startsWith('video/'),
    taken: p.taken,
    w: p.width,
    h: p.height,
    dur: p.duration,
    thumb: p.thumb,
    fav: Boolean(p.fav),
  };
}

module.exports = { Glint, PAGE, mediaType };
