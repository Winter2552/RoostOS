'use strict';

// Car log: fill-ups and running costs, and the sums worked out from them.
// Pure functions only; cars.js keeps the entries on each car and checks who may
// change them. Money is whole pence, distances are whole miles or km (the
// car's own unit), fuel is litres to two places.

const { HttpError, str } = require('./http');

// What the service history lists: the jobs on the car, not fuel or parking.
const HISTORY = new Set(['service', 'repair', 'mot', 'parts', 'tyres']);
const TYPES = {
  fuel: 'Fuel', service: 'Service', repair: 'Repair', mot: 'MOT', parts: 'Parts', tyres: 'Tyres',
  insurance: 'Insurance', tax: 'Road tax', parking: 'Parking', wash: 'Wash', fine: 'Fine', other: 'Other',
};
// How the chart and summaries group them.
const GROUP = { fuel: 'fuel', service: 'service', repair: 'service', mot: 'service', parts: 'service', tyres: 'service', insurance: 'fixed', tax: 'fixed', parking: 'other', wash: 'other', fine: 'other', other: 'other' };
const LITRES_PER_GALLON = 4.54609; // UK gallon
const KM_PER_MILE = 1.609344;
const MAX_ENTRIES = 5000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v && +v.slice(0, 4) >= 1990 && +v.slice(0, 4) <= 2100 ? v : null;
};

// "54.20", "£54.2" or 54.2 -> 5420 pence.
function pence(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[£,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) : null;
}

const wholeNumber = (v, hi) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= hi ? Math.round(n) : NaN;
};

// The entry a person typed, cleaned. `today` stops dates in the far future.
function clean(body, today) {
  const type = body.type in TYPES ? body.type : null;
  if (!type) throw new HttpError(400, 'Pick what the entry is for');
  const date = day(body.date || today);
  if (!date) throw new HttpError(400, 'That date doesn’t look right');
  if (date > new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10)) throw new HttpError(400, 'That date is too far ahead');
  const amount = pence(body.amount);
  if (amount === null) throw new HttpError(400, 'How much was it? Use pounds, like 54.20');
  const odometer = wholeNumber(body.odometer, 2000000);
  if (Number.isNaN(odometer)) throw new HttpError(400, 'The odometer reading doesn’t look right');
  let litres = null;
  if (type === 'fuel') {
    const l = body.litres === '' || body.litres == null ? null : Number(String(body.litres).replace(/[,\s]/g, ''));
    if (l !== null && !(Number.isFinite(l) && l > 0 && l <= 1000)) throw new HttpError(400, 'The litres don’t look right');
    litres = l === null ? null : Math.round(l * 100) / 100;
  }
  // A garage and what was done (or an MOT's result and advisories) make the service history.
  const out = { type, date, odometer, amount, litres, full: type === 'fuel' && body.full !== false, note: str(body.note, 500), garage: str(body.garage, 60) };
  if (type === 'mot') {
    out.result = ['pass', 'fail'].includes(body.result) ? body.result : '';
    out.advisories = str(body.advisories, 500);
  }
  return out;
}

const order = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odometer ?? 0) - (b.odometer ?? 0) || a.created - b.created);

// An odometer reading that disagrees with the entries either side of its date.
// Returns a sentence, or '' when it fits. People are asked, not blocked.
function odometerWarning(entries, entry, exceptId = '') {
  if (entry.odometer == null) return '';
  const others = entries.filter((e) => e.odometer != null && e.id !== exceptId).sort(order);
  const before = [...others].reverse().find((e) => e.date <= entry.date);
  const after = others.find((e) => e.date > entry.date);
  if (before && entry.odometer < before.odometer) return `That’s lower than ${before.odometer.toLocaleString('en-GB')} on ${before.date.split('-').reverse().join('/')}.`;
  if (after && entry.odometer > after.odometer) return `That’s higher than ${after.odometer.toLocaleString('en-GB')} on ${after.date.split('-').reverse().join('/')}, which came later.`;
  return '';
}

// Fuel use from full-tank to full-tank: the distance between two full fills
// over everything put in between (the second fill included, the first not).
function consumption(entries, units) {
  const fills = entries.filter((e) => e.type === 'fuel' && e.odometer != null && e.litres).sort(order);
  let distance = 0;
  let litres = 0;
  let spend = 0;
  let last = null;
  const segments = [];
  let anchor = null;
  let inLitres = 0;
  let inSpend = 0;
  for (const f of fills) {
    if (anchor) {
      inLitres += f.litres;
      inSpend += f.amount;
      if (f.full) {
        const d = f.odometer - anchor.odometer;
        if (d > 0 && inLitres > 0) {
          distance += d;
          litres += inLitres;
          spend += inSpend;
          last = { distance: d, litres: inLitres };
          segments.push({ date: f.date, distance: d, litres: inLitres });
        }
      }
    }
    if (f.full) { anchor = f; inLitres = 0; inSpend = 0; }
  }
  const miles = (d) => (units === 'km' ? d / KM_PER_MILE : d);
  const km = (d) => (units === 'km' ? d : d * KM_PER_MILE);
  const calc = (s) => (s && s.distance > 0 ? {
    mpg: Math.round((miles(s.distance) / (s.litres / LITRES_PER_GALLON)) * 10) / 10,
    l100: Math.round((s.litres / km(s.distance)) * 1000) / 10,
  } : null);
  // One point per tank, oldest first, for the chart.
  const series = segments.slice(-24).map((g) => ({ date: g.date, ...calc(g) }));
  return { overall: calc(distance ? { distance, litres } : null), last: calc(last), fuelPerUnit: distance ? Math.round(spend / distance) : null, series };
}

function sums(entries, today, units) {
  const month = today.slice(0, 7);
  const yearAgo = `${+today.slice(0, 4) - 1}${today.slice(4)}`;
  const months = new Map();
  let thisMonth = 0;
  let thisYear = 0;
  for (const e of entries) {
    const m = e.date.slice(0, 7);
    const row = months.get(m) || { m, fuel: 0, service: 0, fixed: 0, other: 0, total: 0 };
    row[GROUP[e.type]] += e.amount;
    row.total += e.amount;
    months.set(m, row);
    if (m === month) thisMonth += e.amount;
    if (e.date > yearAgo) thisYear += e.amount;
  }
  const withOdo = entries.filter((e) => e.odometer != null && e.date > yearAgo).sort(order);
  const span = withOdo.length > 1 ? withOdo[withOdo.length - 1].odometer - withOdo[0].odometer : 0;
  const lastYear = entries.filter((e) => e.date > yearAgo).sort(order);
  // Running cost per mile: a year of spending over the distance driven in it.
  const perUnit = span >= 100 && lastYear.length ? Math.round(thisYear / span) : null;
  const rows = [...months.values()].sort((a, b) => (a.m < b.m ? -1 : 1)).slice(-12);
  const split = { fuel: 0, service: 0, fixed: 0, other: 0 };
  for (const e of entries) if (e.date > yearAgo) split[GROUP[e.type]] += e.amount;
  return { thisMonth, thisYear, perUnit, months: rows, split, units, ...consumption(entries, units) };
}

function latestOdometer(entries) {
  const withOdo = entries.filter((e) => e.odometer != null).sort(order);
  return withOdo.length ? withOdo[withOdo.length - 1].odometer : null;
}

module.exports = { HISTORY, TYPES, GROUP, MAX_ENTRIES, clean, order, odometerWarning, consumption, sums, latestOdometer, pence, day };
