'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { Memories } = require('../src/glint-memories');
const { People } = require('../src/glint-people');

const USER = { id: 'u' };

function setup(photoCount = 6) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, trash_root TEXT, name TEXT, mime TEXT DEFAULT 'image/jpeg');
    CREATE TABLE photos (id TEXT PRIMARY KEY, owner TEXT, taken INTEGER DEFAULT 0, fav INTEGER DEFAULT 0, duration REAL DEFAULT 0,
      thumb INTEGER DEFAULT 1, hide INTEGER DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0)`);
  for (let i = 0; i < photoCount; i++) {
    db.prepare('INSERT INTO nodes (id, name) VALUES (?, ?)').run(`p${i}`, `IMG_${i}.jpg`);
    db.prepare('INSERT INTO photos (id, owner) VALUES (?, ?)').run(`p${i}`, 'u');
  }
  const memories = new Memories({ db, count: () => photoCount });
  const people = new People({ db, glint: null, memories });
  people.setEnabled('u', true);
  return { db, people };
}

// A face fingerprint near a "who": same seed, a little noise.
function vec(who, noise = 0) {
  return Array.from({ length: 128 }, (_, i) => Math.sin(who * 31 + i) * 0.1 + Math.sin(noise * 7 + i * 3) * 0.004);
}
const face = (who, noise) => ({ box: [100, 100, 300, 300], vec: vec(who, noise), score: 0.9 });

test('faces of one person group together, another person starts a new group', () => {
  const { people } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1), face(2, 1)] });
  people.addFaces(USER, { photo: 'p1', faces: [face(1, 2)] });
  people.addFaces(USER, { photo: 'p2', faces: [face(1, 3), face(2, 2)] });
  people.addFaces(USER, { photo: 'p3', faces: [face(2, 3)] });
  const list = people.list(USER);
  assert.deepEqual(list.map((p) => p.count).sort(), [3, 3]);
  assert.equal(list.length, 2);
  assert.ok(list.every((p) => p.cover && p.cover.box.length === 4));
});

test('small unnamed groups stay out of the list until they are named', () => {
  const { people } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(5, 1)] });
  assert.deepEqual(people.list(USER), []);
  const [only] = people.q.peopleOf.all('u');
  people.update(USER, only.id, { name: 'Mum' });
  assert.deepEqual(people.list(USER).map((p) => [p.name, p.count]), [['Mum', 1]]);
  people.update(USER, only.id, { hidden: true });
  assert.deepEqual(people.list(USER), []);
});

test('merge joins two groups and keeps a name', () => {
  const { people } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1)] });
  people.addFaces(USER, { photo: 'p1', faces: [face(9, 1)] });
  const [a, b] = people.q.peopleOf.all('u');
  people.update(USER, b.id, { name: 'Alex' });
  people.merge(USER, a.id, b.id);
  assert.deepEqual(people.list(USER).map((p) => [p.name, p.count]), [['Alex', 2]]);
  assert.throws(() => people.merge(USER, b.id, b.id), /different/);
});

test('"not this person" moves a photo into a group of its own', () => {
  const { people } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1)] });
  people.addFaces(USER, { photo: 'p1', faces: [face(1, 2)] });
  const [p] = people.q.peopleOf.all('u');
  people.update(USER, p.id, { name: 'Mum' });
  people.reject(USER, p.id, ['p1']);
  const all = people.q.peopleOf.all('u');
  assert.equal(all.length, 2);
  assert.deepEqual(people.list(USER).map((x) => [x.name, x.count]), [['Mum', 1]]);
});

test('a photo reported twice keeps one set of faces, and failed photos are not retried', () => {
  const { people, db } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1)] });
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1), face(2, 1)] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 2);
  people.addFaces(USER, { photo: 'p1', failed: true });
  const todo = people.todo(USER, 20);
  assert.deepEqual(todo.photos.map((p) => p.id), ['p2', 'p3', 'p4', 'p5']);
  assert.deepEqual([todo.scanned, todo.total], [2, 6]);
});

test('bad input is ignored, other people’s photos are refused, and People must be on', () => {
  const { people } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [{ box: [0, 0, 9999, 1], vec: vec(1) }, { box: [1, 1, 2, 2], vec: [1, 2] }, face(1, 1)] });
  assert.equal(people.q.peopleOf.all('u').length, 1);
  assert.throws(() => people.addFaces({ id: 'other' }, { photo: 'p0', faces: [] }), /turn on people/i);
  people.setEnabled('other', true);
  assert.throws(() => people.addFaces({ id: 'other' }, { photo: 'p0', faces: [] }), /gone/);
  people.setEnabled('u', false);
  assert.throws(() => people.list(USER), /Turn on People/);
});

test('delete face data removes everything and reopens the photos', () => {
  const { people, db } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1)] });
  people.deleteAll(USER);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
  assert.equal(people.todo(USER, 20).photos.length, 6);
});

test('photos deleted for good take their faces and empty groups with them', () => {
  const { people, db } = setup();
  people.addFaces(USER, { photo: 'p0', faces: [face(1, 1)] });
  people.forget(['p0']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
});
