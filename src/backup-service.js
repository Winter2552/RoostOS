'use strict';

// The backup service: runs Roost Snapshots every night, in its own container
// built from the Roost image (see docker-compose.yml). It reads Nest and the
// apps' settings read-only and writes only to the backup drive, so the Roost
// web app itself never gets access to either.
//
// It reports through backup-status.json in Roost's data folder, which the web
// app reads for the dashboard line and the setup checklist.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const backup = require('./backup');

const MINUTE = 60 * 1000;
const DRIVE_CHECK_EVERY = 10; // minutes
const CATCH_UP_DELAY = 5 * MINUTE; // after a start with no recent backup
const DAY = 24 * 60 * MINUTE;

function nextAt(time, from = new Date()) {
  const [h, m] = /^\d\d?:\d\d$/.test(time) ? time.split(':').map(Number) : [3, 0];
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

// What to back up, and what to leave out of each.
function sources({ dataDir, nestDir, appDataDir }) {
  const roots = [dataDir, nestDir, appDataDir].filter(Boolean).map((d) => {
    try {
      const st = fs.statSync(d);
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  });
  // A folder that is another source (Roost's own data inside the apps'
  // settings, say) is backed up once, under that source.
  const otherSource = (dir) => {
    try {
      const st = fs.statSync(dir);
      return roots.includes(`${st.dev}:${st.ino}`);
    } catch {
      return false;
    }
  };
  const list = [];
  if (nestDir) {
    list.push({
      label: 'Nest',
      dir: nestDir,
      // Uploads still in progress (<user>/.uploads) aren't files yet.
      skip: (name, depth) => depth === 1 && name === '.uploads',
      skipDir: otherSource,
    });
  }
  list.push({
    label: 'Roost',
    dir: dataDir,
    // Nest's database is added as a safe copy instead (see nestDatabase);
    // this file and half-written temp files aren't worth keeping.
    skip: (name, depth) => depth === 0 && (/^nest\.db(-wal|-shm)?$/.test(name) || name.startsWith(backup.STATUS_FILE) || name.endsWith('.tmp')),
    skipDir: otherSource,
  });
  if (appDataDir) {
    list.push({
      label: 'App settings',
      dir: appDataDir,
      // Caches, transcodes and logs: the apps rebuild them.
      skip: (name, depth, isDir) => isDir && backup.REBUILDABLE.has(name.toLowerCase()),
      skipDir: otherSource,
    });
  }
  return list;
}

// Nest's database is in use all the time, so copying the file could catch it
// half-written. SQLite's VACUUM INTO writes a consistent copy instead.
function nestDatabase(dataDir) {
  return async (tmpDir) => {
    const file = path.join(dataDir, 'nest.db');
    if (!fs.existsSync(file)) return [];
    const out = path.join(tmpDir, 'nest.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    return [{ rel: 'Roost/nest.db', file: out }];
  };
}

function settingsOf(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8')).settings.backup || {};
  } catch {
    return {};
  }
}

const TICK = 5 * 1000; // how often to look for a request from the web app
const HISTORY = 14;

function start({ dataDir, dest, nestDir, appDataDir }) {
  const saved = backup.readStatus(dataDir) || {};
  const status = {
    running: false,
    progress: null,
    drive: null,
    last: saved.last || null,
    lastOk: saved.lastOk || null,
    history: saved.history || [],
    next: null,
    snapshots: [],
  };
  const guard = [dataDir, nestDir, appDataDir].filter(Boolean);
  const save = () => backup.writeStatus(dataDir, status);
  // Admin → Backups sets these; without any, 3:00 with 7 nightly and 4 weekly.
  const config = () => {
    const s = backup.config(settingsOf(dataDir));
    return {
      time: s.time,
      keep: { daily: s.keepDaily, weekly: s.keepWeekly },
      capBytes: s.capGb ? s.capGb * 1000 ** 3 : 0,
    };
  };
  const refreshDrive = () => {
    status.drive = backup.checkDrive(dest, { sameDriveAs: guard });
    status.snapshots = status.drive.ok ? backup.listSnapshots(dest).map((s) => ({ name: s.name, at: s.at.toISOString() })) : [];
  };
  const remember = (entry) => {
    status.history.unshift(entry);
    status.history.length = Math.min(status.history.length, HISTORY);
  };
  const behind = () => !status.lastOk || Date.now() - Date.parse(status.lastOk) > DAY;

  let next = nextAt(config().time);
  refreshDrive();
  // Missed last night (the server was off, or this is the first start)?
  // Catch up shortly, rather than waiting for tomorrow night.
  let catchUp = status.drive.ok && behind();
  if (catchUp) next = new Date(Date.now() + CATCH_UP_DELAY);
  status.next = next.toISOString();
  save();

  let abort = null;

  async function runNow({ manual = false } = {}) {
    const startedAt = new Date().toISOString();
    refreshDrive();
    if (!status.drive.ok) {
      status.last = { ok: false, startedAt, finishedAt: startedAt, error: status.drive.message };
      remember({ ...status.last, manual });
      console.log(`Backup skipped: ${status.drive.message}`);
      save();
      return;
    }
    status.running = true;
    status.progress = { startedAt };
    save();
    const { keep, capBytes } = config();
    abort = new AbortController();
    try {
      const result = await backup.runBackup({
        dest,
        sources: sources({ dataDir, nestDir, appDataDir }),
        extras: nestDatabase(dataDir),
        keep,
        capBytes,
        signal: abort.signal,
        onProgress: (p) => {
          status.progress = { startedAt, ...p };
          save();
        },
      });
      status.last = { ok: true, startedAt, finishedAt: new Date().toISOString(), ...result };
      status.lastOk = status.last.finishedAt;
      remember({ ...status.last, manual });
      console.log(`Backup ${result.snapshot}: ${result.files} files, ${result.written} bytes written, ${result.linked} unchanged, ${result.skipped} skipped`);
    } catch (err) {
      if (err.code === 'CANCELLED') {
        // Stopped by hand: not a failure, so the dashboard keeps showing the last real result.
        remember({ ok: false, cancelled: true, startedAt, finishedAt: new Date().toISOString(), manual });
        console.log('Backup cancelled');
      } else {
        const full = err.code === 'ENOSPC';
        status.last = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: full ? 'The backup drive is full' : `Backup failed: ${err.message}` };
        remember({ ...status.last, manual });
        console.error('Backup failed:', err);
      }
    }
    abort = null;
    refreshDrive();
    status.running = false;
    status.progress = null;
    save();
  }

  let lastCheck = Date.now();
  async function tick() {
    const request = backup.takeRequest(dataDir);
    if (request === 'cancel' && abort) abort.abort();
    if (status.running) return;
    if (request === 'run' || Date.now() >= next.getTime()) {
      await runNow({ manual: request === 'run' });
      next = nextAt(config().time);
      catchUp = false;
      status.next = next.toISOString();
      save();
      lastCheck = Date.now();
    } else if (request === 'reload' || Date.now() - lastCheck >= DRIVE_CHECK_EVERY * MINUTE) {
      lastCheck = Date.now();
      // Also picks up a changed backup time.
      const wasThere = status.drive && status.drive.ok;
      refreshDrive();
      // A drive plugged in after a missed night: back up soon, not at the next 3:00.
      if (!wasThere && status.drive.ok && behind()) {
        catchUp = true;
        next = new Date(Date.now() + CATCH_UP_DELAY);
      } else if (!catchUp) {
        next = nextAt(config().time);
      }
      status.next = next.toISOString();
      save();
    }
  }

  const timer = setInterval(() => tick().catch((err) => console.error('Backup service:', err)), TICK);
  return { timer, runNow, tick, status };
}

if (require.main === module) {
  // Backups run at low priority, so a film streamed late at night doesn't stutter.
  try {
    os.setPriority(19);
  } catch {
    // Not allowed here; run at normal priority.
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const dest = process.env.BACKUP_DIR || '/backup';
  start({
    dataDir,
    dest,
    nestDir: process.env.NEST_DIR || '',
    appDataDir: process.env.APPDATA_DIR || '',
  });
  console.log(`Roost backups: to ${dest}, time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
}

module.exports = { start, sources, nextAt, nestDatabase };
