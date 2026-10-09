'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { cleanSchedule, isDue, clockIn } = require('../src/schedule');

test('a schedule is checked and tidied', () => {
  assert.equal(cleanSchedule(null), null);
  assert.equal(cleanSchedule({ every: 'never' }), null);
  assert.deepEqual(cleanSchedule({ every: 'day', time: '04:00', tz: 'Europe/London', day: 3, extra: 1 }), { every: 'day', time: '04:00', tz: 'Europe/London' });
  assert.deepEqual(cleanSchedule({ every: 'week', time: '23:59', tz: 'UTC', day: '6' }), { every: 'week', time: '23:59', tz: 'UTC', day: 6 });
  for (const bad of [
    { every: 'hour', time: '04:00', tz: 'UTC' },
    { every: 'day', time: '4:00', tz: 'UTC' },
    { every: 'day', time: '24:00', tz: 'UTC' },
    { every: 'day', time: '04:00', tz: 'Mars/Olympus' },
    { every: 'day', time: '04:00' },
    { every: 'week', time: '04:00', tz: 'UTC' },
    { every: 'week', time: '04:00', tz: 'UTC', day: 7 },
  ]) assert.ok(cleanSchedule(bad) instanceof Error, JSON.stringify(bad));
});

test('a schedule is due in its minute, on the clock of its own zone', () => {
  const daily = { every: 'day', time: '04:00', tz: 'Europe/London' };
  // 2026-10-09 is in British summer time (UTC+1), so 04:00 there is 03:00 UTC.
  assert.equal(isDue(daily, new Date('2026-10-09T03:00:20Z')), true);
  assert.equal(isDue(daily, new Date('2026-10-09T04:00:20Z')), false);
  assert.equal(isDue(daily, new Date('2026-10-09T03:01:00Z')), false);
  // After the clocks go back (2026-10-25) the same 04:00 is 04:00 UTC.
  assert.equal(isDue(daily, new Date('2026-10-26T04:00:05Z')), true);
  assert.equal(isDue(daily, new Date('2026-10-26T03:00:05Z')), false);
});

test('a weekly schedule only fires on its day', () => {
  const weekly = { every: 'week', time: '05:30', day: 0, tz: 'UTC' }; // Sundays
  assert.equal(clockIn(new Date('2026-10-11T05:30:00Z'), 'UTC').day, 0);
  assert.equal(isDue(weekly, new Date('2026-10-11T05:30:10Z')), true); // Sunday
  assert.equal(isDue(weekly, new Date('2026-10-12T05:30:10Z')), false); // Monday
  assert.equal(isDue(null), false);
});
