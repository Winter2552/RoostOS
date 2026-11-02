'use strict';

// Glint's "Clear clutter": photos that are probably not worth keeping, gathered into groups for a person
// to look through. Nothing here looks inside a picture and nothing is removed: the groups are worked out
// from what Glint already knows (name, type, size, shape, date) and the person picks what goes to the
// trash, where it waits 30 days. Photos in albums, favourites, Live Photos and anything marked Keep are
// never suggested.

const SHOT_NAME = /screen[ _-]?shot|screen[ _-]?recording|bildschirmfoto|capture d.écran|captura de pantalla/i;
const CHAT_NAME = /^(?:img|vid|aud|ptt|doc)-\d{8}-wa\d+|^(?:signal-|telegram|fb_img|received_\d|messenger|snapchat-|imessage)/i;
const TINY = 600; // pixels on the long side
const CAP = 600; // photos shown per group; the rest appear once these are dealt with
const PHONE_SCREEN = 1.6; // a phone screenshot is much taller than a photo's 4:3 or 3:2

const GROUPS = [
  { id: 'screenshots', title: 'Screenshots', hint: 'Pictures of the phone screen.' },
  { id: 'chat', title: 'Saved from chat apps', hint: 'Photos and videos saved from WhatsApp, Telegram and the like.' },
  { id: 'tiny', title: 'Tiny pictures', hint: `Smaller than ${TINY} pixels: stickers, memes and thumbnails.` },
  { id: 'copies', title: 'Likely copies', hint: 'The same size, shape and second as another photo. One copy of each is kept out of this list.' },
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS clutter_keep (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (owner, id)
  );
`;

function classify(r) {
  const known = r.width > 0 && r.height > 0;
  const long = Math.max(r.width, r.height);
  const ext = (/\.([a-z0-9]+)$/i.exec(r.name) || [])[1] || '';
  const png = r.mime === 'image/png' || ext.toLowerCase() === 'png';
  if (SHOT_NAME.test(r.name)) return 'screenshots';
  // A PNG with no camera date inside, taller than any photo, is a screenshot even when it was renamed.
  if (png && !r.exif && known && long / Math.min(r.width, r.height) >= PHONE_SCREEN) return 'screenshots';
  if (CHAT_NAME.test(r.name)) return 'chat';
  if (!r.duration && known && long < TINY) return 'tiny';
  return null;
}

class Clutter {
  constructor({ db }) {
    this.db = db;
    db.exec(SCHEMA);
    this.q = {
      rows: db.prepare(`SELECT p.*, n.name, n.mime, n.size AS bytes FROM photos p JOIN nodes n ON n.id = p.id
        WHERE p.owner = ? AND n.trash_root IS NULL AND p.hide = 0 AND p.fav = 0 AND p.live IS NULL
        AND NOT EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo = p.id)
        AND NOT EXISTS (SELECT 1 FROM clutter_keep k WHERE k.owner = p.owner AND k.id = p.id)
        ORDER BY p.taken DESC, p.id DESC`),
      keep: db.prepare('INSERT OR IGNORE INTO clutter_keep (owner, id) VALUES (?, ?)'),
    };
  }

  // "Keep": this one is fine, stop suggesting it.
  keep(user, ids) {
    this.db.exec('BEGIN');
    try {
      for (const id of ids.slice(0, 5000)) if (typeof id === 'string' && id.length <= 80) this.q.keep.run(user.id, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return ids.length;
  }

  // [{ id, title, hint, count, bytes, rows }], only the groups that have something in them.
  groups(user) {
    const found = new Map(GROUPS.map((g) => [g.id, []]));
    const same = new Map();
    for (const r of this.q.rows.all(user.id)) {
      const id = classify(r);
      if (id) { found.get(id).push(r); continue; }
      // Rows come newest first, so the first of each set is the one kept out.
      const key = `${r.bytes}|${r.width}|${r.height}|${Math.floor(r.taken / 1000)}`;
      if (same.has(key)) found.get('copies').push(r); else same.set(key, r.id);
    }
    return GROUPS.map((g) => {
      const rows = found.get(g.id);
      return { id: g.id, title: g.title, hint: g.hint, count: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0), rows: rows.slice(0, CAP) };
    }).filter((g) => g.count);
  }
}

module.exports = { Clutter, classify };
