'use strict';

// Power and heat for the status page. The roost-smart helper leaves a small
// `sensors` file (CPU watts, CPU temperature, fan speed) in the shared folder
// every minute; this turns it into tiles and a cost. Reading is one stat call
// unless the helper has written a new file. A reading the machine can't give
// is simply absent, never zero.

const fs = require('fs');
const path = require('path');

// The helper writes every minute; this long without a new file means it stopped.
const STALE_MS = 5 * 60 * 1000;

// The CPU counter doesn't see the board, memory, SSD or fans, or a spinning
// drive. These allowances turn it into a rough whole-box figure.
const BASE_WATTS = 6;
const HDD_WATTS = 4;

const DEFAULT_PRICE = 26.84; // per kWh, in the currency's small unit (pence)
const DEFAULT_CURRENCY = '£';
const MINOR = { '£': 'p', '$': '¢', '€': 'c' };
const HOURS_PER_MONTH = 730;

function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Whole-box watts from the CPU's, given the drives that are spinning now.
function estimateWatts(cpuWatts, spinning) {
  return cpuWatts + BASE_WATTS + HDD_WATTS * spinning;
}

function priceOf(settings) {
  const s = settings || {};
  const price = typeof s.energyPrice === 'number' && s.energyPrice >= 0 ? s.energyPrice : DEFAULT_PRICE;
  return { price, currency: s.energyCurrency || DEFAULT_CURRENCY };
}

// 0.6p, £1.20: small amounts in pence, bigger ones in pounds.
function money(minor, currency) {
  const small = MINOR[currency];
  if (small && minor < 100) return `${minor < 10 ? minor.toFixed(1) : Math.round(minor)}${small}`;
  const major = small ? minor / 100 : minor;
  return `${currency}${major.toFixed(2)}`;
}

function costs(watts, { price, currency }) {
  const perHour = (watts / 1000) * price; // minor units
  return {
    perHour: money(perHour, currency),
    perDay: money(perHour * 24, currency),
    perMonth: money(perHour * HOURS_PER_MONTH, currency),
  };
}

class Sensors {
  constructor(dir) {
    this.dir = dir;
    this.mtime = null;
    this.values = null;
  }

  // The helper's last reading, or null when it isn't set up.
  raw() {
    if (!this.dir) return null;
    const file = path.join(this.dir, 'sensors');
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return { missing: true };
    }
    if (mtime !== this.mtime) {
      try {
        this.values = parse(fs.readFileSync(file, 'utf8'));
        this.mtime = mtime;
      } catch {
        return { missing: true };
      }
    }
    const at = this.values.at ? Date.parse(this.values.at) : NaN;
    return { values: this.values, at: Number.isNaN(at) ? null : new Date(at).toISOString() };
  }

  // What the status page shows. driveHealth is DriveHealth.read(), for the
  // spinning-drive allowance and the hottest drive.
  view({ driveHealth, settings } = {}) {
    const r = this.raw();
    if (!r) return null;
    if (r.missing) return { missing: true };
    const v = r.values;
    const stale = !r.at || Date.now() - Date.parse(r.at) > STALE_MS;
    const drives = (driveHealth && driveHealth.drives) || [];
    const spinning = drives.filter((d) => d.kind === 'HDD' && !d.asleep).length;

    const cpuMw = Number(v.power_mw);
    const cpuWatts = v.power_mw !== undefined && Number.isFinite(cpuMw) ? cpuMw / 1000 : null;
    const temp = Number(v.cpu_temp_mc);
    const fan = Number(v.fan_rpm);
    const hottest = drives
      .filter((d) => d.details && typeof d.details.temp === 'number')
      .sort((a, b) => b.details.temp - a.details.temp)[0];

    let power = null;
    if (cpuWatts !== null) {
      const watts = estimateWatts(cpuWatts, spinning);
      power = { cpuWatts: +cpuWatts.toFixed(1), watts: +watts.toFixed(1), ...costs(watts, priceOf(settings)) };
    }
    return {
      at: r.at,
      stale,
      power,
      cpuTemp: v.cpu_temp_mc !== undefined && Number.isFinite(temp) ? Math.round(temp / 1000) : null,
      fanRpm: v.fan_rpm !== undefined && Number.isFinite(fan) ? fan : null,
      hottestDrive: hottest ? { name: hottest.model || `/dev/${hottest.device}`, temp: hottest.details.temp } : null,
    };
  }
}

module.exports = { Sensors, parse, estimateWatts, priceOf, money, costs, STALE_MS, DEFAULT_PRICE, DEFAULT_CURRENCY };
