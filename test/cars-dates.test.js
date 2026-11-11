'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cars, addMonths, daysBetween, validDay, dayText } = require('../src/cars');

function setup(day = '2026-11-01') {
  const users = [
    { id: 'u1', username: 'raven', role: 'admin' },
    { id: 'u2', username: 'mia', role: 'member' },
    { id: 'u3', username: 'sam', role: 'member' },
    { id: 'g1', username: 'gus', role: 'guest' },
  ];
  const store = { db: { users, cars: [] }, save() {}, newId: (() => { let n = 0; return () => `id${++n}`; })() };
  const clock = { day };
  const cars = new Cars({ store, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cars-')), hasApp: (u) => u.role !== 'guest', userExists: (id) => users.some((u) => u.id === id), today: () => clock.day });
  const raven = users[0];
  const car = cars.create(raven, { name: 'Golf' });
  return { cars, store, clock, raven, users, car, mia: users[1] };
}

test('day maths: months clamp to the end of the month, and bad dates are refused', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2027-11-30', 12), '2028-11-30');
  assert.equal(addMonths('2026-12-15', 2), '2027-02-15');
  assert.equal(daysBetween('2026-11-01', '2026-12-01'), 30);
  assert.equal(validDay('2026-02-30'), null);
  assert.equal(validDay('26-02-03'), null);
  assert.equal(validDay('2026-11-09'), '2026-11-09');
  assert.equal(dayText(-1), 'overdue by 1 day');
  assert.equal(dayText(0), 'due today');
});

test('dates are kept in order of what is due first, with days left', () => {
  const { cars, raven, car } = setup();
  cars.addDate(raven, car.id, { kind: 'insurance', due: '2027-03-14' });
  const v = cars.addDate(raven, car.id, { kind: 'mot', due: '2026-11-22' });
  assert.deepEqual(v.dates.map((d) => [d.label, d.daysLeft]), [['MOT', 21], ['Insurance', 133]]);
  assert.deepEqual(v.next, { label: 'MOT', daysLeft: 21 });
  assert.equal(v.dates[0].repeatMonths, 12, 'MOT repeats yearly by default');
});

test('reminders fire once per lead time, and a new date is told once not twice', () => {
  const { cars, store, raven, car } = setup('2026-11-01');
  cars.addDate(raven, car.id, { kind: 'mot', due: '2026-12-15' });
  assert.equal(cars.remind('2026-11-01').length, 0, '44 days away: not yet');
  const m = cars.remind('2026-11-15');
  assert.equal(m.length, 1, '30 days away: the first lead has arrived');
  assert.match(m[0].body, /MOT is due in 30 days \(15\/12\/2026\)/);
  assert.equal(m[0].title, 'Golf: MOT');
  assert.deepEqual(m[0].userIds, ['u1']);
  assert.equal(cars.remind('2026-11-16').length, 0, 'not told again the next day');
  assert.equal(cars.remind('2026-12-08').length, 1, '7 days away');
  assert.equal(cars.remind('2026-12-15').length, 1, 'due today');
  assert.equal(cars.remind('2026-12-16').length, 0, 'overdue dates are not repeated');
  // Added late: 5 days away already passes the 30 and the 7 lead: one message.
  const tax = cars.addDate(raven, car.id, { kind: 'tax', due: '2026-12-20' }).dates.find((d) => d.kind === 'tax');
  const out = cars.remind('2026-12-15');
  assert.equal(out.filter((o) => o.dateId === tax.id).length, 1);
  assert.deepEqual(store.db.cars[0].dates.find((d) => d.id === tax.id).notified.slice().sort((a, b) => a - b), [7, 30]);
});

test('a date missed while the server was off is not pushed days late', () => {
  const { cars, raven, car } = setup();
  cars.addDate(raven, car.id, { kind: 'mot', due: '2026-11-05' });
  assert.equal(cars.remind('2026-11-20').length, 0);
});

test('snooze holds reminders for a week, then they carry on', () => {
  const { cars, clock, raven, car } = setup('2026-11-01');
  const id = cars.addDate(raven, car.id, { kind: 'mot', due: '2026-11-30' }).dates[0].id;
  cars.snoozeDate(raven, car.id, id);
  assert.equal(cars.remind('2026-11-01').length, 0, 'snoozed');
  assert.equal(cars.view(raven, cars.all()[0]).dates[0].snoozedUntil, '2026-11-08');
  clock.day = '2026-11-08';
  assert.equal(cars.remind('2026-11-08').length, 1, 'the snooze is over');
  assert.equal(cars.view(raven, cars.all()[0]).dates[0].snoozedUntil, '');
});

test('done: repeating dates roll on, new dates can be typed, one-offs finish', () => {
  const { cars, raven, car, clock } = setup('2026-11-10');
  const mot = cars.addDate(raven, car.id, { kind: 'mot', due: '2026-11-22' }).dates[0].id;
  let v = cars.doneDate(raven, car.id, mot);
  assert.equal(v.dates[0].due, '2027-11-22', 'early renewal keeps the anniversary');
  assert.equal(v.dates[0].lastDone, '2026-11-10');
  v = cars.doneDate(raven, car.id, mot, { due: '2027-12-01' });
  assert.equal(v.dates[0].due, '2027-12-01');
  const tyres = cars.addDate(raven, car.id, { kind: 'custom', label: 'Tyres', due: '2026-12-01' }).dates.find((d) => d.label === 'Tyres').id;
  v = cars.doneDate(raven, car.id, tyres);
  assert.deepEqual(v.dates.map((d) => d.label), ['MOT'], 'a one-off drops off once done');
  clock.day = '2028-01-01';
  assert.equal(cars.doneDate(raven, car.id, mot).dates[0].due, '2029-01-01', 'late renewal counts from today');
});

test('who hears: owner, people it is shared with, household; not guests, not archived cars', () => {
  const { cars, raven, car, users } = setup('2026-11-20');
  cars.addDate(raven, car.id, { kind: 'mot', due: '2026-11-22' });
  cars.setShares(raven, car.id, [{ userId: 'u2', role: 'viewer' }, { userId: 'g1', role: 'viewer' }]);
  assert.deepEqual(cars.remind('2026-11-20')[0].userIds.sort(), ['u1', 'u2']);
  cars.update(raven, car.id, { household: true });
  cars.all()[0].dates[0].notified = [];
  assert.deepEqual(cars.remind('2026-11-20')[0].userIds.sort(), ['u1', 'u2', 'u3'], 'household reaches everyone with the app but guests');
  cars.all()[0].dates[0].notified = [];
  cars.archive(raven, car.id, true);
  assert.equal(cars.remind('2026-11-20').length, 0);
  assert.ok(users);
});

test('only the owner edits dates; an editor can mark done; a viewer cannot', () => {
  const { cars, raven, car, mia } = setup();
  const id = cars.addDate(raven, car.id, { kind: 'mot', due: '2026-12-01' }).dates[0].id;
  cars.setShares(raven, car.id, [{ userId: 'u2', role: 'editor' }]);
  assert.throws(() => cars.addDate(mia, car.id, { kind: 'mot', due: '2026-12-02' }), /owner/);
  assert.throws(() => cars.updateDate(mia, car.id, id, { due: '2026-12-02' }), /owner/);
  assert.equal(cars.doneDate(mia, car.id, id).dates[0].due, '2027-12-01');
  cars.setShares(raven, car.id, [{ userId: 'u2', role: 'viewer' }]);
  assert.throws(() => cars.snoozeDate(mia, car.id, id), /only look/);
});

test('bad input is refused', () => {
  const { cars, raven, car } = setup();
  assert.throws(() => cars.addDate(raven, car.id, { kind: 'mot' }), /due/);
  assert.throws(() => cars.addDate(raven, car.id, { kind: 'mot', due: '2026-02-31' }), /look right/);
  assert.throws(() => cars.addDate(raven, car.id, { kind: 'boat', due: '2026-12-01' }), /kind/);
  assert.throws(() => cars.updateDate(raven, car.id, 'nope', { due: '2026-12-01' }), /isn’t there/);
});
