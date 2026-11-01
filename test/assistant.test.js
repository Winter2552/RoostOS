'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Assistant, AssistantError, parseAt, nowText } = require('../src/assistant');

function make(now = Date.parse('2026-11-01T21:44:00Z')) {
  const clock = { t: now };
  const store = { db: {}, save() {} };
  let n = 0;
  return { a: new Assistant({ store, newId: () => `id${++n}`, now: () => clock.t }), clock };
}

test('times are read on the clock they were given, across daylight saving', () => {
  assert.equal(new Date(parseAt('2026-11-05 09:00', 'Europe/London')).toISOString(), '2026-11-05T09:00:00.000Z');
  assert.equal(new Date(parseAt('2026-07-05 09:00', 'Europe/London')).toISOString(), '2026-07-05T08:00:00.000Z');
  assert.equal(new Date(parseAt('2026-07-05T09:00:00+02:00', 'Europe/London')).toISOString(), '2026-07-05T07:00:00.000Z');
  assert.equal(parseAt('tomorrow', 'Europe/London'), null);
  assert.equal(parseAt('2026-13-40 25:61', 'Europe/London'), null);
  assert.match(nowText(Date.parse('2026-11-01T21:44:00Z'), 'Europe/London'), /Sunday,? 1 November 2026, 21:44/);
});

test('memories, tasks and reminders have limits and sensible errors', () => {
  const { a } = make();
  a.remember('Raven lives in Leeds');
  a.remember('raven lives in leeds');
  assert.equal(a.data().memories.length, 1, 'no duplicates');
  assert.throws(() => a.remember('  '), AssistantError);
  assert.throws(() => a.addTask('x', '5 Nov'), /due date/);
  for (let i = 0; i < 100; i++) a.addTask(`t${i}`);
  assert.throws(() => a.addTask('one more'), /full/);
  assert.throws(() => a.addReminder('2020-01-01 09:00', 'old'), /passed/);
  assert.throws(() => a.addReminder('2030-01-01 09:00', 'far'), /too far/);
});

test('a reminder fires once when its time comes', () => {
  const { a, clock } = make();
  a.addReminder('2026-11-02 09:00', 'Call Sam');
  assert.deepEqual(a.dueReminders(), []);
  clock.t = Date.parse('2026-11-02T09:00:30Z');
  assert.deepEqual(a.dueReminders().map((r) => r.text), ['Call Sam']);
  assert.deepEqual(a.dueReminders(), [], 'only once');
});

test('a repeating job runs only after approval, once a minute, and not while paused', () => {
  const { a } = make();
  const job = a.addJob({ text: 'Watch the oak price', every: 'day', time: '08:00', tz: 'Europe/London' });
  const at = new Date('2026-11-02T08:00:10Z');
  assert.deepEqual(a.dueJobs(at), [], 'not approved yet');
  job.approved = true;
  assert.equal(a.dueJobs(at).length, 1);
  assert.equal(a.dueJobs(new Date('2026-11-02T08:00:40Z')).length, 0, 'same minute');
  job.paused = true;
  assert.equal(a.dueJobs(new Date('2026-11-03T08:00:10Z')).length, 0);
  assert.throws(() => a.addJob({ text: 'x', every: 'month', time: '08:00' }), /every day or every week/);
  assert.throws(() => a.addJob({ text: 'x', every: 'week', time: '08:00' }), /day for a weekly job/);
});

test('the morning brief fires once at its time, only when on', () => {
  const { a } = make();
  assert.equal(a.briefDue(new Date('2026-11-02T07:30:05Z')), false, 'off by default');
  a.saveSettings({ briefOn: true, briefTime: '07:30' });
  assert.equal(a.briefDue(new Date('2026-11-02T07:30:05Z')), true);
  assert.equal(a.briefDue(new Date('2026-11-02T07:30:25Z')), false);
});

test('what Claude is told includes the time, notes and open tasks', () => {
  const { a } = make();
  a.remember('Raven lives in Leeds');
  const t = a.addTask('Order oak', '2026-12-01');
  const text = a.context();
  assert.match(text, /Now: Sunday,? 1 November 2026/);
  assert.match(text, /Raven lives in Leeds/);
  assert.match(text, new RegExp(`Order oak \\(due 2026-12-01\\) \\[${t.id}\\]`));
});
