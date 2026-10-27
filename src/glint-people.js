'use strict';

// Glint people: photos grouped by who is in them.
//
// The server never looks at a picture. The browser finds each face and turns
// it into 128 numbers (a "fingerprint": two photos of the same person give
// nearby numbers); this module only keeps those numbers and groups them.
// A new face joins the person whose average fingerprint is closest, or starts
// a new unnamed person. Nothing is regrouped behind anyone's back: naming,
// merging and "not this person" are the person's own corrections.
//
// Off until a person turns it on in Profile, and private to them: the data
// sits in the same SQLite file as their photos and never leaves Roost.
//   faces   one row per face: which photo, where in it, its fingerprint, who
//   people  a group of faces: a name (or none), hidden or not, average fingerprint

const { HttpError, send, readJson, str } = require('./http');

const DIM = 128;
const JOIN_BELOW = 0.5; // distance under which a face joins an existing person (same person is about 0.6 or less)
const MIN_SHOWN = 3; // an unnamed group shows once it has this many photos
const MAX_FACES = 12; // per photo; a crowd is not worth more
const TODO_MAX = 24;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    hidden INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,      -- faces averaged into the centroid
    centroid BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS people_owner ON people (owner);
  CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo TEXT NOT NULL,
    owner TEXT NOT NULL,
    person INTEGER,
    x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, -- 0-1000 of the photo's width and height
    score INTEGER NOT NULL,            -- how clear the face is: bigger and surer is better (picks the cover)
    vec BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS faces_photo ON faces (photo);
  CREATE INDEX IF NOT EXISTS faces_person ON faces (person);
`;

const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function mean(vecs) {
  const out = new Float32Array(DIM);
  for (const v of vecs) for (let i = 0; i < DIM; i++) out[i] += v[i];
  for (let i = 0; i < DIM; i++) out[i] /= vecs.length || 1;
  return out;
}

class People {
  constructor({ db, glint, memories }) {
    this.db = db;
    this.glint = glint;
    this.memories = memories;
    db.exec(SCHEMA);
    const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    // 0 not looked at yet, 1 faces found (or none), 2 the browser couldn't open it.
    if (!has('photos', 'faces')) db.exec('ALTER TABLE photos ADD COLUMN faces INTEGER NOT NULL DEFAULT 0');
    if (!has('glint_prefs', 'people')) db.exec('ALTER TABLE glint_prefs ADD COLUMN people INTEGER NOT NULL DEFAULT 0');
    const q = (sql) => db.prepare(sql);
    this.q = {
      pref: q('SELECT people FROM glint_prefs WHERE owner = ?'),
      setPref: q('INSERT INTO glint_prefs (owner, people) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET people = excluded.people'),
      peopleOf: q('SELECT * FROM people WHERE owner = ?'),
      person: q('SELECT * FROM people WHERE id = ? AND owner = ?'),
      addPerson: q('INSERT INTO people (owner, created, n, centroid) VALUES (?, ?, 1, ?)'),
      setCentroid: q('UPDATE people SET n = ?, centroid = ? WHERE id = ?'),
      dropPerson: q('DELETE FROM people WHERE id = ?'),
      rename: q('UPDATE people SET name = ? WHERE id = ?'),
      hide: q('UPDATE people SET hidden = ? WHERE id = ?'),
      addFace: q('INSERT INTO faces (photo, owner, person, x, y, w, h, score, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      facesOf: q('SELECT id, vec FROM faces WHERE person = ?'),
      movePerson: q('UPDATE faces SET person = ? WHERE person = ?'),
      moveFaces: q('UPDATE faces SET person = ? WHERE person = ? AND photo = ?'),
      photoDone: q('UPDATE photos SET faces = ? WHERE id = ? AND owner = ?'),
      dropPhotoFaces: q('DELETE FROM faces WHERE photo = ?'),
      counts: q(`SELECT f.person, COUNT(DISTINCT f.photo) AS n FROM faces f JOIN photos p ON p.id = f.photo
                 JOIN nodes nd ON nd.id = f.photo WHERE f.owner = ? AND nd.trash_root IS NULL AND p.hide = 0 GROUP BY f.person`),
      covers: q(`SELECT f.person, f.photo, f.x, f.y, f.w, f.h, p.width, p.height, MAX(f.score) FROM faces f JOIN photos p ON p.id = f.photo
                 JOIN nodes nd ON nd.id = f.photo WHERE f.owner = ? AND nd.trash_root IS NULL AND p.thumb = 1 GROUP BY f.person`),
      todo: q(`SELECT p.id, n.name, n.mime FROM photos p JOIN nodes n ON n.id = p.id
               WHERE p.owner = ? AND p.thumb = 1 AND p.faces = 0 AND p.hide = 0 AND n.trash_root IS NULL
               AND n.mime NOT LIKE 'video/%' AND p.duration = 0 ORDER BY p.taken DESC LIMIT ?`),
      scanned: q(`SELECT COUNT(*) AS n FROM photos p JOIN nodes n ON n.id = p.id WHERE p.owner = ? AND p.thumb = 1 AND p.faces != 0
                  AND p.hide = 0 AND n.trash_root IS NULL AND n.mime NOT LIKE 'video/%' AND p.duration = 0`),
      scannable: q(`SELECT COUNT(*) AS n FROM photos p JOIN nodes n ON n.id = p.id WHERE p.owner = ? AND p.thumb = 1
                    AND p.hide = 0 AND n.trash_root IS NULL AND n.mime NOT LIKE 'video/%' AND p.duration = 0`),
      photoOwned: q('SELECT 1 FROM photos WHERE id = ? AND owner = ?'),
      allFaces: q('DELETE FROM faces WHERE owner = ?'),
      allPeople: q('DELETE FROM people WHERE owner = ?'),
      resetPhotos: q('UPDATE photos SET faces = 0 WHERE owner = ?'),
      emptyPeople: q('DELETE FROM people WHERE NOT EXISTS (SELECT 1 FROM faces f WHERE f.person = people.id)'),
    };
  }

  enabled(owner) {
    const r = this.q.pref.get(owner);
    return Boolean(r && r.people === 1);
  }

  setEnabled(owner, on) {
    this.q.setPref.run(owner, on ? 1 : 0);
  }

  needOn(owner) {
    if (!this.enabled(owner)) throw new HttpError(403, 'Turn on People in Profile first');
  }

  // Photos gone for good take their faces with them, and a person left with no faces goes too.
  forget(ids) {
    for (const id of ids) this.q.dropPhotoFaces.run(id);
    if (ids.length) this.q.emptyPeople.run();
  }

  status(user) {
    const total = this.q.scannable.get(user.id).n;
    return { total, scanned: this.q.scanned.get(user.id).n };
  }

  // Photos still to look at, for the browser to work through.
  todo(user, limit) {
    this.needOn(user.id);
    return { photos: this.q.todo.all(user.id, Math.max(1, Math.min(TODO_MAX, limit || 8))), ...this.status(user) };
  }

  // The browser's findings for one photo: store the faces and place each with a person.
  addFaces(user, body) {
    this.needOn(user.id);
    const id = str(body.photo, 40);
    if (!this.q.photoOwned.get(id, user.id)) throw new HttpError(404, 'That photo is gone');
    if (body.failed === true) { this.q.photoDone.run(2, id, user.id); return { added: 0 }; }
    const faces = Array.isArray(body.faces) ? body.faces.slice(0, MAX_FACES) : [];
    const clean = [];
    for (const f of faces) {
      const box = f && f.box;
      const vec = f && f.vec;
      if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000)) continue;
      if (!Array.isArray(vec) || vec.length !== DIM || !vec.every(Number.isFinite)) continue;
      const score = Number(f.score);
      clean.push({ box: box.map(Math.round), vec: Float32Array.from(vec), score: Math.round((Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.5) * box[2]) });
    }
    this.db.exec('BEGIN');
    try {
      this.q.dropPhotoFaces.run(id); // a second report for the same photo replaces the first
      const people = this.q.peopleOf.all(user.id).map((p) => ({ ...p, vec: fromBlob(p.centroid) }));
      const used = new Set();
      for (const f of clean) {
        let best = null;
        for (const p of people) {
          if (used.has(p.id)) continue;
          const d = distance(f.vec, p.vec);
          if (d < JOIN_BELOW && (!best || d < best.d)) best = { p, d };
        }
        let personId;
        if (best) {
          const p = best.p;
          for (let i = 0; i < DIM; i++) p.vec[i] = (p.vec[i] * p.n + f.vec[i]) / (p.n + 1);
          p.n += 1;
          this.q.setCentroid.run(p.n, toBlob(p.vec), p.id);
          personId = p.id;
        } else {
          personId = Number(this.q.addPerson.run(user.id, Date.now(), toBlob(f.vec)).lastInsertRowid);
          people.push({ id: personId, n: 1, vec: f.vec });
        }
        used.add(personId);
        this.q.addFace.run(id, user.id, personId, ...f.box, f.score, toBlob(f.vec));
      }
      this.q.photoDone.run(1, id, user.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { added: clean.length };
  }

  // Who is in the library: named people first, then groups with enough photos to be worth naming.
  list(user) {
    this.needOn(user.id);
    const counts = new Map(this.q.counts.all(user.id).map((r) => [r.person, r.n]));
    const covers = new Map(this.q.covers.all(user.id).map((r) => [r.person, r]));
    const out = [];
    for (const p of this.q.peopleOf.all(user.id)) {
      const count = counts.get(p.id) || 0;
      if (p.hidden || !count || (!p.name && count < MIN_SHOWN)) continue;
      const c = covers.get(p.id);
      out.push({ id: p.id, name: p.name, count, cover: c ? { photo: c.photo, box: [c.x, c.y, c.w, c.h], aspect: c.width && c.height ? c.width / c.height : 0 } : null });
    }
    out.sort((a, b) => Boolean(b.name) - Boolean(a.name) || b.count - a.count);
    return out;
  }

  find(user, id) {
    const p = this.q.person.get(Number(id), user.id);
    if (!p) throw new HttpError(404, 'That person is gone');
    return p;
  }

  // The average fingerprint again, from the faces the person has now; a person left with none is removed.
  recompute(id) {
    const faces = this.q.facesOf.all(id);
    if (!faces.length) { this.q.dropPerson.run(id); return; }
    this.q.setCentroid.run(faces.length, toBlob(mean(faces.map((f) => fromBlob(f.vec)))), id);
  }

  update(user, id, body) {
    const p = this.find(user, id);
    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, 60);
      this.q.rename.run(name, p.id);
    }
    if (typeof body.hidden === 'boolean') this.q.hide.run(body.hidden ? 1 : 0, p.id);
  }

  // Two groups that are the same person: everything moves into `into`, which keeps its name (or takes the other's).
  merge(user, id, intoId) {
    const from = this.find(user, id);
    const into = this.find(user, intoId);
    if (from.id === into.id) throw new HttpError(400, 'Pick a different person to merge with');
    this.db.exec('BEGIN');
    try {
      this.q.movePerson.run(into.id, from.id);
      if (!into.name && from.name) this.q.rename.run(from.name, into.id);
      this.q.dropPerson.run(from.id);
      this.recompute(into.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // "Not this person": the face in each of these photos leaves the group and starts one of its own.
  reject(user, id, photoIds) {
    const p = this.find(user, id);
    this.db.exec('BEGIN');
    try {
      let target = null;
      for (const photo of photoIds) {
        const f = this.db.prepare('SELECT id, vec FROM faces WHERE person = ? AND photo = ?').get(p.id, photo);
        if (!f) continue;
        if (!target) target = Number(this.q.addPerson.run(user.id, Date.now(), f.vec).lastInsertRowid);
        this.q.moveFaces.run(target, p.id, photo);
      }
      this.recompute(p.id);
      if (target) this.recompute(target);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Everything the person's face data holds goes, and every photo is open to a fresh look.
  deleteAll(user) {
    this.db.exec('BEGIN');
    try {
      this.q.allFaces.run(user.id);
      this.q.allPeople.run(user.id);
      this.q.resetPhotos.run(user.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Returns true when it answered.
  async handle(req, res, user, pathname, params) {
    const m = (re) => re.exec(pathname);
    const method = req.method;
    let r;
    if (method === 'GET' && pathname === '/api/glint/people') {
      return send(res, 200, { people: this.list(user), ...this.status(user) }), true;
    }
    if (method === 'GET' && pathname === '/api/glint/faces/todo') {
      return send(res, 200, this.todo(user, Number(params.get('limit')))), true;
    }
    if (method === 'POST' && pathname === '/api/glint/faces') {
      return send(res, 200, this.addFaces(user, await readJson(req, 256 * 1024))), true;
    }
    if (method === 'DELETE' && pathname === '/api/glint/faces') {
      this.deleteAll(user);
      return send(res, 200, { ok: true }), true;
    }
    if ((r = m(/^\/api\/glint\/people\/(\d+)$/)) && method === 'GET') {
      this.needOn(user.id);
      const p = this.find(user, r[1]);
      return send(res, 200, { person: { id: p.id, name: p.name, hidden: Boolean(p.hidden) } }), true;
    }
    if ((r = m(/^\/api\/glint\/people\/(\d+)$/)) && method === 'PATCH') {
      this.update(user, r[1], await readJson(req));
      return send(res, 200, { ok: true }), true;
    }
    if ((r = m(/^\/api\/glint\/people\/(\d+)\/merge$/)) && method === 'POST') {
      const body = await readJson(req);
      this.merge(user, r[1], body.into);
      return send(res, 200, { ok: true }), true;
    }
    if ((r = m(/^\/api\/glint\/people\/(\d+)\/reject$/)) && method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000) throw new HttpError(400, 'Pick at least one photo');
      this.reject(user, r[1], body.ids.map((x) => str(x, 40)));
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }
}

module.exports = { People, distance };
