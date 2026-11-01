'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Assistant } = require('../src/assistant');
const { Calendars, parseIcs, occurrences, cleanUrl } = require('../src/calendar');

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'SUMMARY:Dentist', 'LOCATION:High St', 'DTSTART;TZID=Europe/London:20261105T090000', 'DTEND;TZID=Europe/London:20261105T094500', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Bins', 'DTSTART;VALUE=DATE:20261102', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Book club', 'DTSTART:20261001T190000Z', 'DTEND:20261001T210000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1TH', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Cancelled one', 'STATUS:CANCELLED', 'DTSTART:20261106T100000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Long\\, folded', ' title', 'DTSTART:20261107T100000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const ms = (iso) => Date.parse(iso);

test('events are read with their zone, all-day dates and folded lines', () => {
  const events = parseIcs(ICS);
  assert.deepEqual(events.map((e) => e.summary), ['Dentist', 'Bins', 'Book club', 'Long, foldedtitle'].map((x) => x), 'cancelled one dropped');
  assert.equal(new Date(events[0].start.ms).toISOString(), '2026-11-05T09:00:00.000Z');
  assert.equal(events[1].start.allDay, true);
});

test('repeating events: weekly with a count, and the first Thursday of each month', () => {
  const [, bins, club] = parseIcs(ICS);
  const weeks = occurrences(bins, ms('2026-11-01T00:00:00Z'), ms('2026-12-31T00:00:00Z'));
  assert.deepEqual(weeks.map((o) => new Date(o.start).toISOString().slice(0, 10)), ['2026-11-02', '2026-11-09', '2026-11-16'], 'COUNT=3 stops it');
  const months = occurrences(club, ms('2026-11-01T00:00:00Z'), ms('2027-01-31T00:00:00Z'));
  assert.deepEqual(months.map((o) => new Date(o.start).toISOString().slice(0, 10)), ['2026-11-05', '2026-12-03', '2027-01-07']);
});

test('only https calendar links are accepted', () => {
  assert.equal(cleanUrl('webcal://calendar.google.com/x.ics'), 'https://calendar.google.com/x.ics');
  assert.equal(cleanUrl('http://calendar.google.com/x.ics'), null);
  assert.equal(cleanUrl('https://user:pw@calendar.google.com/x.ics'), null);
  assert.equal(cleanUrl('https://localhost/x.ics'), null);
});

test('upcoming lists the next days across calendars and reports a broken link', async () => {
  const store = { db: {}, save() {} };
  const clock = ms('2026-11-01T21:00:00Z');
  const assistant = new Assistant({ store, newId: () => 'a', now: () => clock });
  let ids = 0;
  const cal = new Calendars({ assistant, seal: (t) => `sealed:${t}`, open: (t) => t.replace('sealed:', ''), now: () => clock, fetchImpl: async (url) => (url.includes('broken') ? new Response('nope', { status: 404 }) : new Response(ICS, { status: 200 })) });
  assert.equal(await cal.add('Home', 'https://calendar.example.com/home.ics', () => `c${++ids}`), 4);
  await assert.rejects(cal.add('Bad', 'https://calendar.example.com/broken.ics', () => 'x'), /404/);
  assert.deepEqual(cal.view(), [{ id: 'c1', name: 'Home' }]);
  const out = await cal.upcoming(7);
  assert.ok(out.lines.some((l) => /Mon 2 Nov all day Bins/.test(l)), out.lines.join('|'));
  assert.ok(out.lines.some((l) => /Thu 5 Nov 09:00-09:45 Dentist \(High St\)/.test(l)));
  assert.equal(out.lines.some((l) => /Cancelled/.test(l)), false);
  assert.ok(cal.remove('c1'));
});
