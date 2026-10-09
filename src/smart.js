'use strict';

// Drive health for the status page. The roost-smart helper container (smart/)
// saves `smartctl --json` for each drive into a shared folder once an hour;
// this turns those files into one plain verdict per drive. Roost never touches
// the drives itself, and reading here costs a directory listing: files are
// only parsed again when the helper has written a new one.

const fs = require('fs');
const path = require('path');

// The helper checks hourly; after this long without a round it has stopped.
const STALE_MS = 3 * 60 * 60 * 1000;

// Heat limits in °C: [keep an eye on it, replace soon / cool it down].
const HOT = { HDD: [50, 60], SSD: [70, 80] };
// SSD wear, as % of its rated life used.
const WORN = [80, 95];

const RANK = { good: 0, watch: 1, bad: 2 };

function attribute(data, id) {
  const table = (data.ata_smart_attributes && data.ata_smart_attributes.table) || [];
  return table.find((a) => a.id === id) || null;
}

const rawOf = (data, id) => {
  const a = attribute(data, id);
  return a && a.raw ? Number(a.raw.value) || 0 : null;
};

function deviceStat(data, name) {
  const pages = (data.ata_device_statistics && data.ata_device_statistics.pages) || [];
  for (const p of pages) {
    const row = (p.table || []).find((r) => r.name === name);
    if (row && typeof row.value === 'number') return row.value;
  }
  return null;
}

function kindOf(data) {
  if (data.device && data.device.protocol === 'NVMe') return 'SSD';
  if (typeof data.rotation_rate === 'number') return data.rotation_rate > 0 ? 'HDD' : 'SSD';
  return 'Drive';
}

// % of an SSD's rated life used, from whichever place this drive reports it.
function wearOf(data, nvme) {
  if (nvme && typeof nvme.percentage_used === 'number') return nvme.percentage_used;
  if (data.endurance_used && typeof data.endurance_used.current_percent === 'number') return data.endurance_used.current_percent;
  const stat = deviceStat(data, 'Percentage Used Endurance Indicator');
  if (stat !== null) return stat;
  // Vendor attributes whose normalised value counts down from 100 as it wears.
  for (const id of [231, 233, 177, 202]) {
    const a = attribute(data, id);
    if (a && typeof a.value === 'number' && a.value <= 100) return 100 - a.value;
  }
  return null;
}

function writtenOf(data, nvme) {
  if (nvme && typeof nvme.data_units_written === 'number') return nvme.data_units_written * 512000;
  const sectors = deviceStat(data, 'Logical Sectors Written');
  return sectors === null ? null : sectors * (data.logical_block_size || 512);
}

// One drive's smartctl output → { kind, model, verdict, reasons, details }.
function judge(data) {
  const nvme = data.nvme_smart_health_information_log || null;
  const kind = kindOf(data);
  const temp = data.temperature && typeof data.temperature.current === 'number'
    ? data.temperature.current
    : nvme && typeof nvme.temperature === 'number' ? nvme.temperature : null;
  const hours = data.power_on_time && typeof data.power_on_time.hours === 'number'
    ? data.power_on_time.hours
    : nvme && typeof nvme.power_on_hours === 'number' ? nvme.power_on_hours : null;
  const reallocated = rawOf(data, 5);
  const pending = rawOf(data, 197);
  const uncorrectable = rawOf(data, 198);
  const reportedErrors = rawOf(data, 187);
  const cableErrors = rawOf(data, 199);
  const wear = kind === 'SSD' ? wearOf(data, nvme) : null;

  const reasons = [];
  let verdict = 'good';
  const flag = (level, text, heat = false) => {
    reasons.push({ level, text, heat });
    if (RANK[level] > RANK[verdict]) verdict = level;
  };

  if (data.smart_status && data.smart_status.passed === false) flag('bad', 'The drive’s own self-check failed');
  if (nvme && nvme.critical_warning) flag('bad', 'The drive reports a critical warning');
  if (pending) flag('bad', `${pending} sector${pending > 1 ? 's' : ''} can’t be read`);
  if (uncorrectable) flag('bad', `${uncorrectable} sector${uncorrectable > 1 ? 's' : ''} lost data`);
  if (reallocated) flag('watch', `${reallocated} worn-out sector${reallocated > 1 ? 's' : ''} replaced`);
  if (reportedErrors) flag('watch', `${reportedErrors} read error${reportedErrors > 1 ? 's' : ''} reported`);
  if (nvme && nvme.media_errors) flag('watch', `${nvme.media_errors} media error${nvme.media_errors > 1 ? 's' : ''}`);
  if (nvme && nvme.available_spare_threshold && nvme.available_spare <= nvme.available_spare_threshold) {
    flag('bad', 'Spare space is used up');
  }
  if (wear !== null && wear >= WORN[1]) flag('bad', `${wear}% of its rated life used`);
  else if (wear !== null && wear >= WORN[0]) flag('watch', `${wear}% of its rated life used`);
  const hot = HOT[kind] || HOT.HDD;
  if (temp !== null && temp >= hot[1]) flag('bad', `Too hot, ${temp}°C`, true);
  else if (temp !== null && temp >= hot[0]) flag('watch', `Running hot, ${temp}°C`, true);

  // Heat alone is fixed with air, not a new drive, so say that instead.
  const wornOut = reasons.some((r) => r.level === 'bad' && !r.heat);
  const headline = verdict === 'good' ? 'Healthy' : verdict === 'watch' ? 'Keep an eye on it' : wornOut ? 'Replace soon' : 'Cool it down';

  const capacity = data.user_capacity && data.user_capacity.bytes
    ? data.user_capacity.bytes
    : data.nvme_total_capacity || null;
  return {
    kind,
    model: data.model_name || data.model_family || '',
    serial: data.serial_number || '',
    capacity,
    verdict,
    headline,
    // Worst first, so the card can lead with the one that matters.
    reasons: reasons.sort((a, b) => RANK[b.level] - RANK[a.level]).map((r) => r.text),
    details: {
      temp,
      hours,
      wear,
      written: kind === 'SSD' ? writtenOf(data, nvme) : null,
      reallocated,
      pending,
      uncorrectable,
      // Bad-cable count. It never resets, so it is shown, not judged.
      cableErrors,
    },
  };
}

class DriveHealth {
  constructor(dir) {
    this.dir = dir;
    this.key = null;
    this.result = null;
  }

  read() {
    if (!this.dir) return null;
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return { drives: [], checkedAt: null, stale: false, missing: true };
    }
    const stamps = names.map((n) => {
      try {
        return `${n}@${fs.statSync(path.join(this.dir, n)).mtimeMs}`;
      } catch {
        return n;
      }
    });
    const key = stamps.join('|');
    if (key !== this.key) {
      this.result = this.load(names);
      this.key = key;
    }
    const { checkedAt } = this.result;
    return { ...this.result, stale: !checkedAt || Date.now() - new Date(checkedAt).getTime() > STALE_MS };
  }

  load(names) {
    const file = (n) => path.join(this.dir, n);
    const has = new Set(names);
    let checkedAt = null;
    try {
      checkedAt = new Date(fs.readFileSync(file('checked'), 'utf8').trim()).toISOString();
    } catch {
      // The helper hasn't finished a round yet.
    }
    const devices = [...new Set(names.map((n) => n.replace(/\.(json|error|asleep)$/, '')).filter((n) => n !== 'checked'))];
    const drives = devices.map((device) => {
      const asleep = has.has(`${device}.asleep`);
      if (has.has(`${device}.error`)) {
        return { device, verdict: 'unknown', headline: 'Can’t tell', reasons: ['Roost can’t read this drive’s health'], asleep };
      }
      if (!has.has(`${device}.json`)) {
        return { device, verdict: 'unknown', headline: 'Not read yet', reasons: ['Asleep since Roost started checking'], asleep };
      }
      try {
        const raw = fs.readFileSync(file(`${device}.json`), 'utf8');
        const readAt = fs.statSync(file(`${device}.json`)).mtime.toISOString();
        return { device, ...judge(JSON.parse(raw)), readAt, asleep };
      } catch {
        return { device, verdict: 'unknown', headline: 'Can’t tell', reasons: ['The last reading couldn’t be understood'], asleep };
      }
    });
    return { drives, checkedAt };
  }
}

module.exports = { DriveHealth, judge, STALE_MS };
