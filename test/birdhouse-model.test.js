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

test('a sentence picks the project and the size each number belongs to', () => {
  const p = model.parse('A bookshelf, 1800 tall, 80cm wide, 30 cm deep, 6 shelves');
  assert.equal(p.template, 'bookshelf');
  assert.deepEqual(p.set, { height: 1800, width: 800, depth: 300, shelves: 6 });
  assert.deepEqual(p.unused, []);
});

test('sizes can come before or after their word, in other units', () => {
  assert.deepEqual(model.parse('table, length 1.8m, 90cm wide, height 75cm, 3cm thick top').set, { width: 1800, depth: 900, height: 750, thickness: 30 });
  assert.deepEqual(model.parse('bench 36 inches long').set, { width: 914 });
  assert.deepEqual(model.parse('table 1,200 long, 0,7 m wide').set, { width: 1200, depth: 700 });
});

test('A x B x C is read in the order each project is usually quoted', () => {
  assert.deepEqual(model.parse('bookshelf 1800 x 800 x 300').set, { height: 1800, width: 800, depth: 300 });
  assert.deepEqual(model.parse('table 1200 × 700 × 740').set, { width: 1200, depth: 700, height: 740 });
  assert.deepEqual(model.parse('box 40 x 30 x 20 cm').set, { width: 400, depth: 300, height: 200 });
});

test('what it cannot place is reported, and no project word keeps the current one', () => {
  const p = model.parse('make it 55 and 300 wide', 'table');
  assert.equal(p.template, null);
  assert.deepEqual(p.set, { depth: 300 });
  assert.deepEqual(p.unused, ['55']);
  assert.deepEqual(model.parse('table with 4 shelves').unused, ['4']);
  assert.deepEqual(model.parse('').set, {});
  assert.deepEqual(model.parse('x'.repeat(5000)).set, {});
});

test('whatever is typed ends up inside the limits', () => {
  const p = model.parse('bookshelf 99999 tall, 1 wide');
  const d = model.clean({ template: p.template, ...p.set });
  assert.equal(d.height, 2400);
  assert.equal(d.width, 200);
});

test('the default bookshelf fits on one sheet, with every board placed once and none overlapping', () => {
  const l = model.layout(shelf);
  assert.equal(l.sheets.length, 1);
  assert.equal(l.tooBig.length, 0);
  const all = l.sheets[0].pieces;
  assert.equal(all.length, 7);
  for (const p of all) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= 2440 && p.y + p.h <= 1220, 'inside the sheet');
  for (const a of all) for (const b of all) {
    if (a === b) continue;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no two boards overlap');
  }
  assert.ok(l.used / l.area > 0.3 && l.used / l.area < 1);
});

test('boards of different thickness never share a sheet, and a big plan takes more sheets', () => {
  const l = model.layout(model.defaults('table'));
  assert.deepEqual(l.sheets.map((s) => s.thickness), [25], 'only the top is a sheet cut');
  assert.deepEqual(l.timber.map((g) => [g.width, g.thickness, g.bars.length]).sort(), [[60, 60, 2], [80, 20, 2]].sort(), 'legs and aprons come from timber lengths');
  assert.equal(l.sheets.reduce((n, s) => n + s.pieces.length, 0) + l.timber.reduce((n, g) => n + g.bars.reduce((m, b) => m + b.pieces.length, 0), 0), 9);
  for (const g of l.timber) for (const b of g.bars) assert.ok(b.pieces.reduce((a, p) => a + p.len + 3, 0) - 3 <= 2400, 'no bar longer than the timber');
  const big = model.layout({ ...shelf, height: 2400, width: 2400, depth: 800, shelves: 12 });
  assert.ok(big.sheets.length >= 3);
});

test('a board too big for any sheet is reported, and a smaller sheet is respected', () => {
  const l = model.layout(shelf, { sheet: [1500, 1000] });
  assert.equal(l.tooBig.length, 2, 'the two 1800 mm sides');
  assert.equal(l.sheets.reduce((n, s) => n + s.pieces.length, 0), 5);
  assert.equal(model.layout(shelf, { kerf: 0 }).sheets.length, 1);
  assert.equal(model.layout(model.defaults('table'), { timber: 600 }).tooBig.length, 6, 'the four legs and two long aprons are longer than 600');
});

test('the shopping list has the sheets and timber from the layout plus fixings, each with a search and a guess', () => {
  const shelfList = model.materials(shelf);
  assert.deepEqual(shelfList.map((m) => [m.key, m.qty]), [['sheet-18', 1], ['screws', 1], ['glue', 1]]);
  const tableList = model.materials(model.defaults('table'));
  assert.deepEqual(tableList.map((m) => [m.key, m.qty]), [['sheet-25', 1], ['timber-80x20', 2], ['timber-60x60', 2], ['screws', 1], ['glue', 1]]);
  for (const m of [...shelfList, ...tableList]) {
    assert.ok(Number.isFinite(m.estimate) && m.estimate > 0 && m.estimate < 500, m.key);
    assert.ok(m.search.length > 4 && m.label.length > 4);
  }
  assert.ok(new Set(tableList.map((m) => m.key)).size === tableList.length, 'one line per material');
});

test('wood already in the workshop is used before buying, and offcuts that are too small are left alone', () => {
  const d = model.defaults('bookshelf');
  const bought = model.materials(d).filter((m) => m.key.startsWith('sheet-') || m.key.startsWith('timber-'));
  assert.ok(bought.every((m) => m.have === 0));

  // Plenty of full sheets and long timber of every size the plan needs.
  const l = model.layout(d);
  const stock = [
    ...l.sheets.map((s) => ({ kind: 'sheet', thick: s.thickness, w: 2440, l: 1220, qty: 5 })),
    ...l.timber.map((g) => ({ kind: 'timber', w: g.width, thick: g.thickness, l: 2400, qty: 5 })),
  ];
  const rich = model.materials(d, { stock });
  for (const m of rich.filter((x) => x.key !== 'screws' && x.key !== 'glue')) {
    assert.equal(m.qty, 0, `${m.key} needs nothing bought`);
    assert.ok(m.have > 0);
  }
  const rl = model.layout(d, { stock });
  assert.ok(rl.sheets.every((s) => s.owned));
  assert.ok(rl.timber.every((g) => g.bars.every((b) => b.owned)));

  // An offcut too small for any board is ignored; a half sheet takes some boards.
  const tiny = model.layout(d, { stock: [{ kind: 'sheet', thick: l.sheets[0].thickness, w: 50, l: 50, qty: 1 }] });
  assert.equal(tiny.sheets.filter((s) => s.owned).length, 0);
  const half = model.layout(d, { stock: [{ kind: 'sheet', thick: l.sheets[0].thickness, w: 1220, l: 1220, qty: 1 }] });
  assert.ok(half.sheets.some((s) => s.owned && s.pieces.length));
  assert.ok(half.sheets.filter((s) => !s.owned).length <= l.sheets.length);
  // Nothing is cut past the edge of the owned piece.
  for (const s of half.sheets) for (const p of s.pieces) assert.ok(p.x + p.w <= s.width && p.y + p.h <= s.height);
});

test('stock rows are cleaned', () => {
  const o = model.ownedStock([{ kind: 'sheet', thick: 18, w: 600, l: 1200, qty: 2 }, { kind: 'timber', w: 94, thick: 44, l: 2400, qty: 1 }, { kind: 'x' }, null, { kind: 'sheet', thick: 0, w: 1, l: 1, qty: 1 }]);
  assert.equal(o.sheets.length, 2);
  assert.deepEqual(o.sheets[0], { thick: 18, w: 1200, l: 600 });
  assert.deepEqual(o.timber, [{ w: 94, thick: 44, l: 2400 }]);
  assert.deepEqual(model.ownedStock('nope'), { sheets: [], timber: [] });
});

test('every project makes real boards at its smallest, default and biggest sizes', () => {
  for (const id of model.IDS) {
    const t = model.TEMPLATES[id];
    for (const pick of ['min', null, 'max']) {
      const d = model.clean({ template: id, ...Object.fromEntries(Object.entries(t.limits).map(([k, lim]) => [k, pick ? lim[pick] : t.defaults[k]])) });
      for (const b of model.solids(d)) assert.ok(b.w > 0 && b.d > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.z >= 0, `${id} ${pick} ${b.name}`);
      assert.ok(model.parts(d).length > 0);
      assert.equal(typeof t.chips(d, (v) => `${v}!`)[0], 'string');
    }
  }
});

test('a cabinet has doors in front of its box, a desk has a back panel, and "2 doors" is a count', () => {
  const c = model.defaults('cabinet');
  assert.equal(model.solids(c).filter((b) => b.name === 'Door').length, 2);
  assert.equal(model.solids({ ...c, doors: 0 }).filter((b) => b.name === 'Door').length, 0);
  assert.equal(model.size(c).depth, c.depth);
  assert.equal(model.parse('cabinet 900 tall 3 shelves 1 door', null).set.doors, 1);
  assert.ok(model.solids(model.defaults('desk')).some((b) => b.name === 'Back panel'));
  assert.equal(model.parse('desk 1500 x 750 x 740', null).template, 'desk');
});
