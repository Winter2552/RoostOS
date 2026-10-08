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

function start({ dataDir, dest, nestDir, appDataDir, time = '03:00' }) {
  const saved = backup.readStatus(dataDir) || {};
  const status = {
    running: false,
    progress: null,
    drive: null,
    last: saved.last || null,
    lastOk: saved.lastOk || null,
    next: null,
    snapshots: [],
  };
  const guard = [dataDir, nestDir, appDataDir].filter(Boolean);
  const save = () => backup.writeStatus(dataDir, status);
  const config = () => {
    const s = settingsOf(dataDir);
    return {
      time: s.time || time,
      keep: { daily: s.keepDaily || backup.DEFAULT_KEEP.daily, weekly: s.keepWeekly || backup.DEFAULT_KEEP.weekly },
      capBytes: s.capGb ? s.capGb * 1000 ** 3 : 0,
    };
  };
  const refreshDrive = () => {
    status.drive = backup.checkDrive(dest, { sameDriveAs: guard });
    status.snapshots = status.drive.ok ? backup.listSnapshots(dest).map((s) => ({ name: s.name, at: s.at.toISOString() })) : [];
  };

  let next = nextAt(config().time);
  refreshDrive();
  // Missed last night (the server was off, or this is the first start)?
  // Catch up shortly, rather than waiting for tomorrow night.
  if (status.drive.ok && (!status.lastOk || Date.now() - Date.parse(status.lastOk) > DAY)) {
    next = new Date(Date.now() + CATCH_UP_DELAY);
  }
  status.next = next.toISOString();
  save();

  async function runNow() {
    status.running = true;
    status.progress = { startedAt: new Date().toISOString() };
    refreshDrive();
    const startedAt = new Date().toISOString();
    if (!status.drive.ok) {
      status.last = { ok: false, startedAt, finishedAt: startedAt, error: status.drive.message };
      console.log(`Backup skipped: ${status.drive.message}`);
    } else {
      save();
      const { keep, capBytes } = config();
      try {
        const result = await backup.runBackup({
          dest,
          sources: sources({ dataDir, nestDir, appDataDir }),
          extras: nestDatabase(dataDir),
          keep,
          capBytes,
          onProgress: (p) => {
            status.progress = { startedAt, ...p };
            save();
          },
        });
        status.last = { ok: true, startedAt, finishedAt: new Date().toISOString(), ...result };
        status.lastOk = status.last.finishedAt;
        console.log(`Backup ${result.snapshot}: ${result.files} files, ${result.written} bytes written, ${result.linked} unchanged, ${result.skipped} skipped`);
      } catch (err) {
        const full = err.code === 'ENOSPC';
        status.last = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: full ? 'The backup drive is full' : `Backup failed: ${err.message}` };
        console.error('Backup failed:', err);
      }
      refreshDrive();
    }
    status.running = false;
    status.progress = null;
    save();
  }

  let minutes = 0;
  const timer = setInterval(async () => {
    minutes++;
    if (status.running) return;
    if (Date.now() >= next.getTime()) {
      await runNow();
      next = nextAt(config().time);
      status.next = next.toISOString();
      save();
    } else if (minutes % DRIVE_CHECK_EVERY === 0) {
      // Also picks up a changed backup time.
      const planned = nextAt(config().time);
      if (planned < next || next.getTime() - Date.now() > DAY) next = planned;
      status.next = next.toISOString();
      refreshDrive();
      save();
    }
  }, MINUTE);
  return { timer, runNow, status };
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
    time: process.env.BACKUP_TIME || '03:00',
  });
  console.log(`Roost backups: to ${dest}, nightly at ${process.env.BACKUP_TIME || '03:00'} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
}

module.exports = { start, sources, nextAt, nestDatabase };
