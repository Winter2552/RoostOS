'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { Memories, pick } = require('../src/glint-memories');

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 26, 12); // 26 Oct 2026

function library(photos) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, trash_root TEXT);
    CREATE TABLE photos (id TEXT PRIMARY KEY, owner TEXT, taken INTEGER, fav INTEGER DEFAULT 0, duration REAL DEFAULT 0, thumb INTEGER DEFAULT 1, hide INTEGER DEFAULT 0)`);
  let n = 0;
  for (const p of photos) {
    const id = `p${n++}`;
    db.prepare('INSERT INTO nodes (id) VALUES (?)').run(id);
    db.prepare('INSERT INTO photos (id, owner, taken, fav) VALUES (?, ?, ?, ?)').run(id, 'u', p.taken, p.fav ? 1 : 0);
  }
  return new Memories({ db, count: () => photos.length });
}

const burst = (start, count, step = 60e3) => Array.from({ length: count }, (_, i) => ({ taken: start + i * step }));

test('pick collapses bursts, keeps favourites and spreads the rest', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, taken: i * 60e3, fav: i === 50, duration: 0 }));
  const got = pick(rows, 10);
  assert.equal(got.length, 10);
  assert.ok(got.some((r) => r.id === 'r50'));
  assert.deepEqual(got.map((r) => r.taken), [...got.map((r) => r.taken)].sort((a, b) => a - b));
  const bursty = [{ id: 'a', taken: 0, fav: 0 }, { id: 'b', taken: 500, fav: 1 }, { id: 'c', taken: 900, fav: 0 }];
  assert.deepEqual(pick(bursty).map((r) => r.id), ['b']);
  assert.deepEqual(pick([{ id: 'v', taken: 0, duration: 4 }]), []); // videos aren't picked
});

test('on this day, recent highlights, trips and years', () => {
  const m = library([
    ...burst(Date.UTC(2023, 9, 26, 10), 6), // on this day, three years ago
    ...burst(Date.UTC(2025, 5, 10, 9), 40, 600e3), // trip over three days in June 2025
    ...burst(Date.UTC(2025, 5, 11, 9), 40, 600e3),
    ...burst(Date.UTC(2025, 5, 12, 9), 40, 600e3),
    ...burst(NOW - 3 * DAY, 12, 3600e3), // the last two weeks
  ]);
  const cards = m.cards('u', 0, NOW);
  const kinds = cards.map((c) => c.kind);
  assert.deepEqual(kinds, ['otd', 'recent', 'trip', 'year']);
  assert.equal(cards[0].sub, '3 years ago');
  assert.equal(cards[2].title, 'Jun 2025');
  assert.equal(cards[3].title, '2025 in photos');
  assert.ok(cards.every((c) => c.cover && c.ids.includes(c.cover)));
});

test('a quiet library makes no memories, and hiding one is remembered', () => {
  assert.deepEqual(library(burst(NOW - 400 * DAY, 3)).cards('u', 0, NOW), []);
  const m = library(burst(Date.UTC(2024, 9, 26, 10), 6));
  const [card] = m.cards('u', 0, NOW);
  assert.equal(card.sub, '2 years ago');
  m.hide('u', card.id);
  assert.deepEqual(m.cards('u', 0, NOW), []);
  assert.equal(m.find('u', card.id), null);
});

test('the viewer’s time zone decides which day a photo belongs to', () => {
  // 23:30 UTC on 25 Oct 2023 is already the 26th for someone at UTC+1 (offset -60).
  const m = library(burst(Date.UTC(2023, 9, 25, 23, 30), 6, 60e3));
  assert.deepEqual(m.cards('u', 0, NOW), []);
  assert.equal(m.cards('u', -60, NOW)[0].kind, 'otd');
});
