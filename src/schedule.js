'use strict';

// Scheduled restarts: an app's schedule is { every: 'day' | 'week', time: 'HH:MM',
// day: 0-6 (Sunday = 0, weekly only), tz: an IANA zone like 'Europe/London' }.
// The time is read in the zone the admin saved it from, so "04:00" stays 04:00
// on their clock through daylight saving changes.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    // Throws a RangeError for a zone name that doesn't exist.
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

// → { day, time } on the clock in that zone.
function clockIn(date, tz) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAYS.indexOf(parts.weekday), time: `${parts.hour}:${parts.minute}` };
}

// A saved schedule from the Admin form → a clean one, null for "Never", or an
// Error saying what is wrong.
function cleanSchedule(input) {
  if (!input || input.every === 'never') return null;
  if (input.every !== 'day' && input.every !== 'week') return new Error('Auto-restart must be never, every day or every week');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time))) return new Error('Auto-restart time must look like 04:00');
  const tz = String(input.tz || '');
  try {
    formatter(tz);
  } catch {
    return new Error('Auto-restart needs a valid time zone');
  }
  const schedule = { every: input.every, time: input.time, tz };
  if (input.every === 'week') {
    const day = Number(input.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return new Error('Pick a day of the week for the auto-restart');
    schedule.day = day;
  }
  return schedule;
}

// True during the minute the schedule names.
function isDue(schedule, date = new Date()) {
  if (!schedule) return false;
  const now = clockIn(date, schedule.tz);
  return now.time === schedule.time && (schedule.every === 'day' || now.day === schedule.day);
}

module.exports = { cleanSchedule, isDue, clockIn, DAYS };
