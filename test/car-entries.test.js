'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/car-entries');
const { Cars } = require('../src/cars');

const fill = (date, odometer, litres, amount, full = true) => ({ id: `${date}-${odometer}`, type: 'fuel', date, odometer, litres, amount, full, created: 0 });

test('money, dates and numbers are read carefully', () => {
  assert.equal(lib.pence('54.20'), 5420);
  assert.equal(lib.pence('£1,054.2'), 105420);
  assert.equal(lib.pence('-3'), null);
  assert.equal(lib.pence('lots'), null);
  assert.equal(lib.clean({ type: 'fuel', date: '2026-11-10', amount: '54.2', litres: '38.4', odometer: '41,320' }, '2026-11-11').odometer, 41320);
  assert.throws(() => lib.clean({ type: 'boat', amount: '1' }, '2026-11-11'), /what the entry/);
  assert.throws(() => lib.clean({ type: 'fuel', date: '2027-03-01', amount: '1' }, '2026-11-11'), /too far ahead/);
  assert.throws(() => lib.clean({ type: 'fuel', amount: '1', litres: '0' }, '2026-11-11'), /litres/);
  assert.throws(() => lib.clean({ type: 'fuel', amount: '1', odometer: 'abc' }, '2026-11-11'), /odometer/);
  assert.equal(lib.clean({ type: 'parking', amount: '3', litres: '9' }, '2026-11-11').litres, null, 'litres only count on fuel');
});

test('consumption runs from full tank to full tank, counting partial fills in between', () => {
  const simple = [fill('2026-10-01', 10000, 40, 6000), fill('2026-10-20', 10450, 41, 6150)];
  assert.equal(lib.consumption(simple, 'mi').overall.mpg, 49.9);
  const partial = [fill('2026-10-01', 10000, 40, 6000), fill('2026-10-10', 10200, 20, 3000, false), fill('2026-10-20', 10450, 20, 3000)];
  assert.equal(lib.consumption(partial, 'mi').overall.mpg, 51.1);
  assert.equal(lib.consumption([fill('2026-10-01', 10000, 40, 6000)], 'mi').overall, null, 'one fill is not enough');
  // Kilometres: 450 km on 41 L is 9.1 L/100 km.
  assert.equal(lib.consumption(simple, 'km').overall.l100, 9.1);
});

test('the odometer is checked against what came before and after, but only as a warning', () => {
  const list = [fill('2026-10-01', 10000, 40, 6000), fill('2026-10-20', 10450, 41, 6150)];
  assert.equal(lib.odometerWarning(list, { date: '2026-10-25', odometer: 10500 }), '');
  assert.match(lib.odometerWarning(list, { date: '2026-10-25', odometer: 10100 }), /lower than 10,450 on 20\/10\/2026/);
  assert.match(lib.odometerWarning(list, { date: '2026-10-10', odometer: 10600 }), /higher than 10,450/);
  assert.equal(lib.odometerWarning(list, { date: '2026-10-10', odometer: null }), '');
});

test('sums: this month, a year, spend by month and what it costs per mile', () => {
  const list = [
    { ...fill('2026-10-01', 10000, 40, 6000), id: 'a' },
    { ...fill('2026-11-02', 10450, 41, 6150), id: 'b' },
    { id: 'c', type: 'service', date: '2026-11-05', odometer: null, amount: 21200, created: 0 },
    { id: 'd', type: 'parking', date: '2026-11-06', odometer: null, amount: 300, created: 0 },
    { id: 'e', type: 'insurance', date: '2025-01-01', odometer: null, amount: 60000, created: 0 },
  ];
  const s = lib.sums(list, '2026-11-11', 'mi');
  assert.equal(s.thisMonth, 6150 + 21200 + 300);
  assert.equal(s.thisYear, 6000 + 6150 + 21200 + 300, 'last 12 months only');
  assert.deepEqual(s.months.map((m) => m.m), ['2025-01', '2026-10', '2026-11']);
  assert.deepEqual(s.months[2], { m: '2026-11', fuel: 6150, service: 21200, fixed: 0, other: 300, total: 27650 });
  assert.deepEqual(s.split, { fuel: 12150, service: 21200, fixed: 0, other: 300 });
  assert.equal(s.perUnit, Math.round(33650 / 450), 'a year of spending over 450 miles');
  assert.equal(lib.sums([list[0]], '2026-11-11', 'mi').perUnit, null, 'not enough miles to say');
});

function setup() {
  const users = [{ id: 'u1', username: 'raven', role: 'admin' }, { id: 'u2', username: 'mia', role: 'member' }, { id: 'u3', username: 'sam', role: 'member' }];
  const store = { db: { users, cars: [] }, save() {}, newId: (() => { let n = 0; return () => `id${++n}`; })() };
  const cars = new Cars({ store, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cars-')), hasApp: () => true, userExists: (id) => users.some((u) => u.id === id), today: () => '2026-11-11' });
  const car = cars.create(users[0], { name: 'Golf' });
  return { cars, raven: users[0], mia: users[1], sam: users[2], car };
}

test('entries: add, warn on a odd reading, accept it when forced, retry safely', () => {
  const { cars, raven, car } = setup();
  const first = cars.addEntry(raven, car.id, { type: 'fuel', date: '2026-11-01', odometer: 41000, litres: 40, amount: '60', cid: 'x1' });
  assert.equal(first.stats.units, 'mi');
  assert.throws(() => cars.addEntry(raven, car.id, { type: 'fuel', date: '2026-11-05', odometer: 40000, litres: 30, amount: '45' }), (e) => e.status === 409 && e.code === 'check-odometer');
  cars.addEntry(raven, car.id, { type: 'fuel', date: '2026-11-05', odometer: 40000, litres: 30, amount: '45', force: true });
  const again = cars.addEntry(raven, car.id, { type: 'fuel', date: '2026-11-01', odometer: 41000, litres: 40, amount: '60', cid: 'x1' });
  assert.equal(again.count, 2, 'the same cid is stored once');
  assert.equal(cars.view(raven, cars.all()[0]).odometer, 40000, 'the latest reading by date, as forced');
});

test('entries: owner edits any, an editor only their own, a viewer none', () => {
  const { cars, raven, mia, sam, car } = setup();
  cars.setShares(raven, car.id, [{ userId: 'u2', role: 'editor' }, { userId: 'u3', role: 'viewer' }]);
  const mine = cars.addEntry(raven, car.id, { type: 'wash', amount: '5' }).entry;
  const hers = cars.addEntry(mia, car.id, { type: 'parking', amount: '3.50' }).entry;
  assert.equal(hers.canEdit, true);
  assert.throws(() => cars.updateEntry(mia, car.id, mine.id, { amount: '1' }), /your own/);
  assert.equal(cars.updateEntry(raven, car.id, hers.id, { amount: '4' }).entries.find((e) => e.id === hers.id).amount, 400);
  assert.throws(() => cars.addEntry(sam, car.id, { type: 'wash', amount: '5' }), /only look/);
  assert.equal(cars.entriesOf(sam, car.id).entries.find((e) => e.id === mine.id).canEdit, false);
  assert.equal(cars.removeEntry(mia, car.id, hers.id).count, 1);
  assert.throws(() => cars.removeEntry(mia, car.id, mine.id), /your own/);
});
