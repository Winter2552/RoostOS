'use strict';

// Phone photo backup: the server side of "send new photos and videos from a
// phone, on its own". Files go through Nest's upload engine (chunked,
// resumable, counted against the user's storage limit) into My Drive/Photos/
// <year>, exactly where Glint's own uploads go, so they appear in the Glint
// timeline. The Glint page already handles photos picked by hand; this is for
// things that run without anyone at the screen (an iPhone Shortcut, a future
// phone app). It adds what those need: remembering what was already sent by
// the phone's own photo ids, so nothing is uploaded twice.
//
// The phone names each photo with an id that is stable for that photo (an
// iPhone's local identifier, or "name|size|modified" from a browser). It asks
//   POST /api/backup/check    { items: [{ id }] }              -> { have: [id] }
// and for the ones it doesn't have, sends them with
//   POST /api/backup/uploads  { id, device, name, size, type, taken }
//   PUT  /api/backup/uploads/<upload id>?offset=N   (raw bytes, in pieces)
// The phone signs in with a device key (the "device" sign-in the installable
// app uses), so it never needs a browser cookie.

const { DatabaseSync } = require('node:sqlite');
const { HttpError, send, readJson, str } = require('./http');
const { cleanName } = require('./nest');

const MAX_CHECK = 500; // photos per check

class PhotoBackup {
  constructor({ nest, dbFile }) {
    this.nest = nest;
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sent (
        owner TEXT NOT NULL,
        id TEXT NOT NULL,
        node TEXT NOT NULL,
        device TEXT NOT NULL,
        size INTEGER NOT NULL,
        sent INTEGER NOT NULL,
        PRIMARY KEY (owner, id)
      );
      CREATE TABLE IF NOT EXISTS pending (
        upload TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        id TEXT NOT NULL,
        device TEXT NOT NULL,
        created INTEGER NOT NULL
      );
    `);
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      sent: q('SELECT node FROM sent WHERE owner = ? AND id = ?'),
      addSent: q('INSERT OR REPLACE INTO sent (owner, id, node, device, size, sent) VALUES (?, ?, ?, ?, ?, ?)'),
      addPending: q('INSERT OR REPLACE INTO pending (upload, owner, id, device, created) VALUES (?, ?, ?, ?, ?)'),
      pending: q('SELECT * FROM pending WHERE upload = ? AND owner = ?'),
      dropPending: q('DELETE FROM pending WHERE upload = ?'),
      stale: q('DELETE FROM pending WHERE created < ?'),
      stats: q('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, MAX(sent) AS last FROM sent WHERE owner = ?'),
    };
    // Nest drops uploads left for a day; so do we.
    this.q.stale.run(Date.now() - 2 * 864e5);
  }

  close() {
    this.db.close();
  }

  // A photo counts as sent only while its file is still in Nest and not in the
  // trash, so deleting a copy by mistake lets the phone send it again.
  has(user, id) {
    const row = this.q.sent.get(user.id, id);
    if (!row) return false;
    const node = this.nest.q.get.get(row.node, user.id);
    return Boolean(node && node.trash_root == null);
  }

  check(user, body) {
    if (!Array.isArray(body.items) || body.items.length > MAX_CHECK) throw new HttpError(400, `Send up to ${MAX_CHECK} photos at a time`);
    const have = [];
    for (const it of body.items) {
      const id = str(it && it.id, 300);
      if (id && this.has(user, id)) have.push(id);
    }
    return { have };
  }

  // Photos go in Photos/<year taken>, like Glint's own uploads (today when the phone doesn't say).
  folderFor(taken) {
    const d = Number.isFinite(taken) && taken > 0 && taken < Date.now() + 864e5 ? new Date(taken) : new Date();
    return `Photos/${d.getUTCFullYear()}`;
  }

  // True once any phone has sent a photo; the setup checklist ticks off on it.
  anySent() {
    return this.db.prepare('SELECT 1 FROM sent LIMIT 1').get() !== undefined;
  }

  status(user) {
    const s = this.q.stats.get(user.id);
    return { photos: s.n, bytes: s.bytes, last: s.last || null };
  }

  async handle(req, res, user, pathname, params) {
    const method = req.method;
    let r;
    if (method === 'GET' && pathname === '/api/backup/status') return send(res, 200, this.status(user));
    if (method === 'POST' && pathname === '/api/backup/check') {
      return send(res, 200, this.check(user, await readJson(req)));
    }
    if (method === 'POST' && pathname === '/api/backup/uploads') {
      const body = await readJson(req, 16 * 1024);
      const id = str(body.id, 300);
      if (!id) throw new HttpError(400, 'Each photo needs an id');
      if (this.has(user, id)) return send(res, 200, { have: true });
      const device = cleanName(str(body.device, 60)) || 'Phone';
      const out = this.nest.startUpload(user, {
        name: body.name,
        size: body.size,
        type: body.type,
        path: this.folderFor(Number(body.taken)),
      });
      if (out.done) {
        this.q.addSent.run(user.id, id, out.item.id, device, out.item.size, Date.now());
        return send(res, 201, out);
      }
      this.q.addPending.run(out.id, user.id, id, device, Date.now());
      return send(res, 201, out);
    }
    if (method === 'PUT' && (r = /^\/api\/backup\/uploads\/([\w-]+)$/.exec(pathname))) {
      const offset = Number(params.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Bad offset');
      const out = await this.nest.putChunk(user, r[1], offset, req);
      if (out.done) {
        const p = this.q.pending.get(r[1], user.id);
        if (p) {
          this.q.addSent.run(user.id, p.id, out.item.id, p.device, out.item.size, Date.now());
          this.q.dropPending.run(r[1]);
        }
      }
      return send(res, out.resend ? 409 : 200, out);
    }
    if (method === 'DELETE' && (r = /^\/api\/backup\/uploads\/([\w-]+)$/.exec(pathname))) {
      this.nest.cancelUpload(user, r[1]);
      this.q.dropPending.run(r[1]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  }
}

module.exports = { PhotoBackup };
