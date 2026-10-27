'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../public/birdhouse-model');

const shelf = model.defaults('bookshelf');

test('the default bookshelf has two sides and evenly spaced boards from top to bottom', () => {
  const v = model.view(shelf, 'front');
  assert.deepEqual([v.width, v.height, v.shapes.length], [800, 1800, 7]);
  const across = model.solids(shelf).filter((b) => b.name !== 'Side');
  assert.deepEqual(across.map((b) => b.z), [0, 446, 891, 1337, 1782]);
  assert.ok(v.shapes.every((s) => !s.hidden), 'nothing hides anything from the front');
});

test('the cut list groups boards by name and size', () => {
  assert.deepEqual(model.parts(shelf).map((r) => [r.name, r.qty, r.length, r.width, r.thickness]), [
    ['Side', 2, 1800, 300, 18],
    ['Top and bottom', 2, 764, 300, 18],
    ['Shelf', 3, 764, 300, 18],
  ]);
  assert.ok(!model.parts({ ...shelf, shelves: 2 }).some((r) => r.name === 'Shelf'));
});

test('from the side the shelves are hidden by the side boards, from above by the top', () => {
  const side = model.view(shelf, 'side');
  assert.deepEqual([side.width, side.height], [300, 1800]);
  assert.equal(side.shapes.filter((s) => s.hidden).length, 6, 'the 5 shelves, and the far side board behind the near one');
  const top = model.view(shelf, 'top');
  assert.deepEqual([top.width, top.height], [800, 300]);
  assert.equal(top.shapes.filter((s) => s.hidden).length, 4, 'the lower boards');
});

test('sizes are kept within sensible limits and boards never get thicker than the gap', () => {
  const d = model.clean({ height: 99999, width: 10, depth: 'x', shelves: 0, thickness: 400 });
  assert.equal(d.template, 'bookshelf');
  assert.equal(d.height, 2400);
  assert.equal(d.depth, 300);
  assert.equal(d.shelves, 2);
  assert.ok(d.thickness * 2 < d.width);
  assert.equal(model.clean({ template: 'nope' }).template, 'bookshelf');
});

test('every template builds boards that stay inside its stated size and never overlap oddly', () => {
  for (const id of model.IDS) {
    const d = model.defaults(id);
    const all = model.solids(d);
    assert.ok(all.length >= 4, id);
    for (const b of all) {
      assert.ok(b.w > 0 && b.d > 0 && b.h > 0, `${id} ${b.name} has size`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.z >= 0, `${id} ${b.name} starts inside`);
    }
    const s = model.size(d);
    assert.ok(model.parts(d).every((r) => r.length >= r.width && r.width >= r.thickness && r.qty >= 1), id);
    assert.equal(model.view(d, 'front').width, s.width);
    // Extremes of every slider still make sensible boards.
    for (const [key, lim] of Object.entries(model.TEMPLATES[id].limits)) {
      for (const v of [lim.min, lim.max]) {
        const e = model.clean({ ...d, [key]: v });
        for (const b of model.solids(e)) assert.ok(b.w > 0 && b.d > 0 && b.h > 0, `${id} ${key}=${v}: ${b.name}`);
      }
    }
  }
});

test('the table has a top, four legs and four aprons, the bench a seat, two ends and a stretcher', () => {
  const count = (id) => Object.fromEntries(model.parts(model.defaults(id)).map((r) => [r.name, r.qty]));
  assert.deepEqual(count('table'), { Top: 1, Leg: 4, 'Long apron': 2, 'Short apron': 2 });
  assert.deepEqual(count('bench'), { Seat: 1, 'End panel': 2, Stretcher: 1 });
  assert.deepEqual(count('box'), { Bottom: 1, 'Front and back': 2, End: 2 });
  const t = model.size(model.defaults('table'));
  assert.deepEqual([t.width, t.depth, t.height], [1200, 700, 740]);
});

test('from the front a table hides its back legs, back apron and the short aprons behind the front legs', () => {
  const v = model.view(model.defaults('table'), 'front');
  assert.equal(v.shapes.filter((s) => s.hidden).length, 5, 'two back legs, the back apron, two short aprons');
});

test('3D draws the near faces furthest-first and turning the model changes the picture', () => {
  const faces = model.project(shelf, 0.6, 0.35);
  assert.ok(faces.length > 0 && faces.every((f) => f.pts.length === 4 && f.light > 0 && f.light < 1));
  const flat = model.project(shelf, 0, 0);
  assert.equal(flat.length, 7, 'straight on and level a bookshelf shows only front faces');
  const xs = flat.flatMap((f) => f.pts.map((p) => p[0]));
  assert.ok(Math.abs(Math.min(...xs) + 400) < 1 && Math.abs(Math.max(...xs) - 400) < 1, 'width 800 centred');
  const from = (yaw) => JSON.stringify(model.project(shelf, yaw, 0.5));
  assert.notEqual(from(0), from(1));
  assert.ok(model.project(shelf, 0, 0.5).length > flat.length);
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
