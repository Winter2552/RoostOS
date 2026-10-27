'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../public/birdhouse-model');

test('the default bookshelf has two sides and evenly spaced boards from top to bottom', () => {
  const f = model.front(model.DEFAULTS);
  assert.equal(f.boards.filter((b) => b.kind === 'side').length, 2);
  const across = f.boards.filter((b) => b.kind !== 'side');
  assert.equal(across.length, 5);
  assert.equal(across[0].y, 0);
  assert.equal(across[4].y + across[4].h, 1800);
  assert.deepEqual(across.map((b) => b.y), [0, 446, 891, 1337, 1782]);
});

test('the cut list adds up to every board', () => {
  const rows = model.parts(model.DEFAULTS);
  assert.deepEqual(rows.map((r) => [r.name, r.qty, r.length, r.width, r.thickness]), [
    ['Side', 2, 1800, 300, 18],
    ['Top and bottom', 2, 764, 300, 18],
    ['Shelf', 3, 764, 300, 18],
  ]);
});

test('two boards means no loose shelves in the cut list', () => {
  const rows = model.parts({ ...model.DEFAULTS, shelves: 2 });
  assert.ok(!rows.some((r) => r.name === 'Shelf'));
});

test('sizes are kept within sensible limits and boards never get thicker than the gap', () => {
  const d = model.clean({ height: 99999, width: 10, depth: 'x', shelves: 0, thickness: 400 });
  assert.equal(d.height, 2400);
  assert.equal(d.depth, 300);
  assert.equal(d.shelves, 2);
  assert.ok(d.thickness * 2 < d.width);
});

test('in the browser it adds one name to the page and nothing else', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const window = {};
  const ctx = vm.createContext({ window });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'birdhouse-model.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(window), ['birdhouseModel']);
  assert.equal(Object.keys(ctx).filter((k) => k !== 'window').length, 0, 'no stray globals that could clash with app.js');
});

test('the side view shows each board as a line, the top view the footprint', () => {
  const s = model.side(model.DEFAULTS);
  assert.deepEqual([s.width, s.height, s.lines.length], [300, 1800, 5]);
  assert.deepEqual(model.top(model.DEFAULTS), { width: 800, height: 300, thickness: 18 });
});

test('every board becomes a solid, and 3D draws the near faces furthest-first', () => {
  assert.equal(model.solids(model.DEFAULTS).length, 7);
  const faces = model.project(model.DEFAULTS, 0.6, 0.35);
  assert.ok(faces.length > 0 && faces.every((f) => f.pts.length === 4 && f.light > 0 && f.light < 1));
  // Straight on from the front and level, a bookshelf shows only front faces.
  const flat = model.project(model.DEFAULTS, 0, 0);
  assert.equal(flat.length, 7);
  const xs = flat.flatMap((f) => f.pts.map((p) => p[0]));
  assert.ok(Math.abs(Math.min(...xs) + 400) < 1 && Math.abs(Math.max(...xs) - 400) < 1, 'width 800 centred');
});

test('looking from above shows the top board and turning the model changes the picture', () => {
  const from = (yaw) => JSON.stringify(model.project(model.DEFAULTS, yaw, 0.5));
  assert.notEqual(from(0), from(1));
  assert.ok(model.project(model.DEFAULTS, 0, 0.5).length > model.project(model.DEFAULTS, 0, 0).length);
});
