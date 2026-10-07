'use strict';

// Server health for the status page: CPU, memory, drives and uptime.
// Plain Node (os + fs.statfs), so it needs no packages.

const fs = require('fs');
const os = require('os');

// "System=/hostfs/system;Data=/hostfs/data" → [{ label, path }]
function parseDisks(spec) {
  return String(spec || '')
    .split(';')
    .map((part) => {
      const i = part.indexOf('=');
      return i > 0 ? { label: part.slice(0, i).trim(), path: part.slice(i + 1).trim() } : null;
    })
    .filter((d) => d && d.label && d.path);
}

function readDisks(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    try {
      // Two paths on the same drive would only show it twice, so keep the first.
      const dev = fs.statSync(d.path).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const s = fs.statfsSync(d.path);
      out.push({ label: d.label, path: d.path, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch {
      out.push({ label: d.label, path: d.path, missing: true });
    }
  }
  return out;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total, at: Date.now() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class CpuMeter {
  constructor() {
    this.last = cpuTimes();
    this.percent = null;
  }

  // Busy share of all cores since the previous reading. The page polls every
  // few seconds, so each reading covers the gap since the last refresh.
  async read() {
    if (Date.now() - this.last.at < 250) {
      if (this.percent !== null) return this.percent;
      await wait(250);
    } else if (Date.now() - this.last.at > 60 * 1000) {
      this.last = cpuTimes();
      await wait(250);
    }
    const now = cpuTimes();
    const total = now.total - this.last.total;
    const idle = now.idle - this.last.idle;
    this.last = now;
    if (total > 0) this.percent = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
    return this.percent ?? 0;
  }
}

async function serverHealth({ cpu, disks }) {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
    roostUptime: process.uptime(),
    cpu: {
      percent: await cpu.read(),
      cores: cpus.length,
      model: cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim() : '',
      // Windows has no load average (Node reports zeros), so leave it out there.
      load: os.platform() === 'win32' ? null : os.loadavg(),
    },
    memory: { total: os.totalmem(), free: os.freemem(), available: availableMemory() },
    disks: readDisks(disks),
  };
}

// os.freemem() leaves out the page cache Linux will hand back on demand, which
// makes a healthy server look full. MemAvailable is the honest number.
function availableMemory() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch {
    // Not Linux; fall back to freemem.
  }
  return os.freemem();
}

module.exports = { parseDisks, readDisks, CpuMeter, serverHealth };
