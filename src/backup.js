'use strict';

// Roost Snapshots: backups to a drive plugged into the server.
//
// Each run makes a dated folder on the backup drive that looks like a full copy:
//   <drive>/Roost Backups/2026-10-08 0300/Nest/...
// Files unchanged since the last run are hard links to the copy already there,
// so they take no space and no time. Only new or changed files are written,
// and identical files (the same photo saved twice) are stored once. Files that
// shrink well (documents, settings, databases) are stored gzipped with ".gz"
// added to the name; photos and videos are already compressed, so they are
// stored as they are.
//
// Each snapshot's .roost-manifest.json.gz lists every file with its size,
// date and checksum: the next run compares against it to find what changed,
// and a restore uses it to find each file and put its date back.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT = 'Roost Backups';
const MARKER = '.roost-backup';
const MANIFEST = '.roost-manifest.json.gz';
const PARTIAL = '.partial';
const STATUS_FILE = 'backup-status.json';

// Worth gzipping: text, settings and databases. Everything else (photos,
// videos, music, zips, Office files, PDFs) is already compressed.
const COMPRESSIBLE = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'log',
  'ini', 'conf', 'cfg', 'yaml', 'yml', 'toml', 'svg', 'sql', 'rtf', 'doc', 'xls',
  'ppt', 'db', 'db-wal', 'sqlite', 'sqlite3', 'bak', 'nfo', 'srt', 'vtt',
]);
const MIN_COMPRESS = 4096; // smaller files fit in one disk block either way
const COPY_TRIES = 3; // a file still changing after this is kept as last read
const KEEP_SKIPPED = 20; // how many skipped files the status lists by name

// Folders in app settings that apps rebuild themselves, so backing them up
// only costs space: caches (Jellyfin's artwork cache), transcodes and logs.
const REBUILDABLE = new Set(['cache', 'caches', '.cache', 'transcodes', 'transcoding-temp', 'tmp', 'temp', 'log', 'logs', 'lost+found']);

const DEFAULT_KEEP = { daily: 7, weekly: 4 };

// ---------- the drive ----------

// Checks the backup folder is a drive of its own and ready to use. The big
// risk is the drive being unplugged: the folder then still exists, but on the
// system SSD, and backing up into it would fill that SSD. So the backup
// folder must not be on the same drive as anything it backs up.
function checkDrive(dest, { sameDriveAs = [], allowSameDrive = false } = {}) {
  let st;
  try {
    st = fs.statSync(dest);
  } catch {
    return { ok: false, reason: 'missing', message: 'Backup drive not found' };
  }
  if (!st.isDirectory()) return { ok: false, reason: 'missing', message: 'Backup drive not found' };
  if (!allowSameDrive) {
    for (const dir of sameDriveAs) {
      try {
        if (fs.statSync(dir).dev === st.dev) {
          return { ok: false, reason: 'same-drive', message: 'Backup drive not found: the backup folder is on the same drive as your data' };
        }
      } catch {
        // A source that isn't there can't share a drive.
      }
    }
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dest, MARKER), 'utf8'));
  } catch {
    // A new drive: claim it, after checking it can hold hard links (Linux
    // formats like ext4 can; exFAT and NTFS can't).
    try {
      marker = claim(dest);
    } catch (err) {
      if (err.code === 'LINKS') return { ok: false, reason: 'format', message: 'The backup drive needs formatting as ext4 (ZimaOS Storage can do it)' };
      return { ok: false, reason: 'readonly', message: 'Roost can’t write to the backup drive' };
    }
  }
  const space = freeSpace(dest);
  return { ok: true, id: marker.id, claimedAt: marker.claimedAt, ...space };
}

function claim(dest) {
  const a = path.join(dest, `${MARKER}.a`);
  const b = path.join(dest, `${MARKER}.b`);
  fs.writeFileSync(a, '');
  try {
    fs.linkSync(a, b);
  } catch {
    const err = new Error('No hard links');
    err.code = 'LINKS';
    throw err;
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
  const marker = { id: crypto.randomBytes(8).toString('hex'), claimedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dest, MARKER), JSON.stringify(marker));
  return marker;
}

function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

// ---------- snapshots ----------

const pad = (n) => String(n).padStart(2, '0');

function snapshotName(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function parseName(name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d)(?:-\d+)?$/.exec(name);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

// Finished snapshots, newest first.
function listSnapshots(dest) {
  let names;
  try {
    names = fs.readdirSync(path.join(dest, ROOT));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, at: parseName(name) }))
    .filter((s) => s.at && fs.existsSync(path.join(dest, ROOT, s.name, MANIFEST)))
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

function weekKey(d) {
  // Monday-based week: the date of that week's Monday.
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
}

// Which snapshots to keep: the newest of each of the last `daily` days that
// have one, and the newest of each of the last `weekly` weeks. Takes the list
// newest first and returns the names to delete.
function toPrune(snapshots, keep = DEFAULT_KEEP) {
  const days = new Set();
  const weeks = new Set();
  const drop = [];
  snapshots.forEach((s, i) => {
    const day = s.at.toDateString();
    const week = weekKey(s.at);
    let kept = i === 0;
    if (!days.has(day) && days.size < keep.daily) {
      days.add(day);
      kept = true;
    }
    if (!weeks.has(week) && weeks.size < keep.weekly) {
      weeks.add(week);
      kept = true;
    }
    if (!kept) drop.push(s.name);
  });
  return drop;
}

function removeSnapshot(dest, name) {
  // Deleting removes only this snapshot's links; files newer snapshots still
  // use stay on the drive.
  return fsp.rm(path.join(dest, ROOT, name), { recursive: true, force: true });
}

// Drops old snapshots: first by the keep rules, then the oldest ones while
// the drive is over the size cap. The newest snapshot is always kept.
async function prune(dest, { keep = DEFAULT_KEEP, capBytes = 0 } = {}) {
  const removed = [];
  for (const name of toPrune(listSnapshots(dest), keep)) {
    await removeSnapshot(dest, name);
    removed.push(name);
  }
  if (capBytes > 0) {
    let list = listSnapshots(dest);
    while (list.length > 1) {
      const { total, free } = freeSpace(dest);
      if (total - free <= capBytes) break;
      const oldest = list.pop();
      await removeSnapshot(dest, oldest.name);
      removed.push(oldest.name);
    }
  }
  return removed;
}

async function readManifest(dir) {
  try {
    const data = await fsp.readFile(path.join(dir, MANIFEST));
    return JSON.parse(zlib.gunzipSync(data).toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- a run ----------

const storedName = (rel, gz) => (gz ? `${rel}.gz` : rel);

function compressible(name, size) {
  if (size < MIN_COMPRESS) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  return COMPRESSIBLE.has(ext);
}

// Copies one file to `to`, gzipping it if asked, and returns its checksum.
// The checksum is of the original content, so a gzipped and a plain copy of
// the same file match.
async function copyFile(from, to, gz) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const steps = [fs.createReadStream(from, { highWaterMark: 1 << 20 }), tap];
  if (gz) steps.push(zlib.createGzip());
  steps.push(fs.createWriteStream(to, { flags: 'wx' }));
  await pipeline(steps);
  return { hash: hash.digest('base64url'), size };
}

const sameStat = (a, b) => a.size === b.size && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs);

// Errors that mean the backup drive is in trouble: stop the run.
function driveError(err, dest) {
  return ['ENOSPC', 'EROFS', 'EIO', 'EDQUOT'].includes(err.code) || (err.path && err.path.startsWith(dest));
}

class Run {
  constructor({ dest, prev, prevDir, onProgress }) {
    this.dest = dest;
    this.prevDir = prevDir;
    this.prev = new Map((prev ? prev.files : []).map((f) => [f[0], f]));
    // Checksum → a stored copy to link to, starting with last run's files.
    this.hashes = new Map();
    for (const f of this.prev.values()) {
      if (!this.hashes.has(f[3])) this.hashes.set(f[3], { file: path.join(prevDir, storedName(f[0], f[4])), gz: f[4] });
    }
    this.onProgress = onProgress;
    this.files = [];
    this.stats = { files: 0, bytes: 0, written: 0, linked: 0, deduped: 0, compressed: 0, skipped: 0 };
    this.skippedSample = [];
    this.seq = 0;
    this.lastProgress = 0;
  }

  skip(rel, why) {
    this.stats.skipped++;
    if (this.skippedSample.length < KEEP_SKIPPED) this.skippedSample.push({ path: rel, why });
  }

  progress() {
    const now = Date.now();
    if (this.onProgress && now - this.lastProgress > 2000) {
      this.lastProgress = now;
      this.onProgress({ ...this.stats });
    }
  }

  async walk(srcDir, rel, depth, source, outDir) {
    await fsp.mkdir(outDir, { recursive: true });
    let entries;
    try {
      entries = await fsp.readdir(srcDir, { withFileTypes: true });
    } catch (err) {
      this.skip(rel, err.code || 'unreadable');
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    // Sorted so a database is copied straight before its -wal file.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(srcDir, e.name);
      const childRel = `${rel}/${e.name}`;
      if (source.skip && source.skip(e.name, depth, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (source.skipDir && (await source.skipDir(abs))) continue;
        await this.walk(abs, childRel, depth + 1, source, path.join(outDir, e.name));
      } else if (e.isFile()) {
        await this.file(abs, childRel, names.has(`${e.name}.gz`));
      }
      // Links, sockets and devices are skipped: they aren't files to keep.
    }
  }

  async file(abs, rel, gzTaken) {
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      this.skip(rel, err.code || 'unreadable');
      return;
    }
    this.stats.files++;
    this.stats.bytes += st.size;
    this.progress();

    // Unchanged since last run: link to last run's copy.
    const before = this.prev.get(rel);
    if (before && before[1] === st.size && before[2] === Math.trunc(st.mtimeMs) && !(before[4] && gzTaken)) {
      try {
        await fsp.link(path.join(this.prevDir, storedName(rel, before[4])), path.join(this.dest, storedName(rel, before[4])));
        this.files.push(before);
        this.stats.linked++;
        return;
      } catch (err) {
        if (err.code === 'ENOSPC') throw err;
        // Last run's copy is gone; copy it again below.
      }
    }

    const gz = compressible(rel, st.size) && !gzTaken;
    const tmp = path.join(this.tmpDir, String(this.seq++));
    let copied;
    for (let tries = 1; ; tries++) {
      try {
        copied = await copyFile(abs, tmp, gz);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        if (driveError(err, this.tmpDir)) throw err;
        this.stats.files--;
        this.stats.bytes -= st.size;
        this.skip(rel, err.code || 'unreadable');
        return;
      }
      // A file being written while it was read (a database at work, say) is
      // read again, so the copy is of one moment.
      const after = await fsp.stat(abs).catch(() => null);
      if (!after || sameStat(st, after) || tries >= COPY_TRIES) break;
      st = after;
      await fsp.rm(tmp, { force: true });
    }

    // Already stored (the same file elsewhere, or last run's copy under an
    // old name): link to it instead of keeping a second copy.
    const known = this.hashes.get(copied.hash);
    if (known && !(known.gz && gzTaken)) {
      try {
        await fsp.link(known.file, path.join(this.dest, storedName(rel, known.gz)));
        await fsp.rm(tmp, { force: true });
        this.files.push([rel, copied.size, Math.trunc(st.mtimeMs), copied.hash, known.gz ? 1 : 0]);
        this.stats.deduped++;
        return;
      } catch (err) {
        if (err.code === 'ENOSPC') throw err;
        // Too many links to one file, or it's gone: keep this copy instead.
      }
    }

    let stored = gz;
    if (gz) {
      // Kept gzipped only if that is actually smaller.
      if ((await fsp.stat(tmp)).size >= copied.size) {
        await fsp.rm(tmp, { force: true });
        await copyFile(abs, tmp, false);
        stored = false;
      } else {
        this.stats.compressed++;
      }
    }
    const out = path.join(this.dest, storedName(rel, stored));
    await fsp.rename(tmp, out);
    await fsp.utimes(out, st.atime, st.mtime);
    this.hashes.set(copied.hash, { file: out, gz: stored });
    this.files.push([rel, copied.size, Math.trunc(st.mtimeMs), copied.hash, stored ? 1 : 0]);
    this.stats.written += (await fsp.stat(out)).size;
  }
}

// One backup. sources: [{ label, dir, skip?(name, depth, isDir), skipDir?(absDir) }].
// extras: async (tmpDir) => [{ rel, file }] for files made just for the backup
// (like a safe copy of a live database), which are deleted afterwards.
async function runBackup({ dest, sources, extras, keep = DEFAULT_KEEP, capBytes = 0, onProgress, now = new Date() }) {
  const root = path.join(dest, ROOT);
  await fsp.mkdir(root, { recursive: true });
  // Clear what a run cut short left behind.
  for (const name of await fsp.readdir(root)) {
    if (name.endsWith(PARTIAL) || name.startsWith('.tmp-')) await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }
  // Make room first, so a full drive doesn't stop tonight's backup.
  const pruned = await prune(dest, { keep, capBytes });

  const last = listSnapshots(dest)[0];
  const prevDir = last ? path.join(root, last.name) : null;
  const prev = prevDir ? await readManifest(prevDir) : null;

  let name = snapshotName(now);
  for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${snapshotName(now)}-${n}`;
  const work = path.join(root, name + PARTIAL);
  const tmpDir = path.join(root, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(work);
  await fsp.mkdir(tmpDir);

  const run = new Run({ dest: work, prev, prevDir, onProgress });
  run.tmpDir = tmpDir;
  try {
    for (const source of sources) {
      if (!fs.existsSync(source.dir)) {
        run.skip(source.label, 'not found');
        continue;
      }
      await run.walk(source.dir, source.label, 0, source, path.join(work, source.label));
    }
    if (extras) {
      for (const extra of await extras(tmpDir)) {
        await fsp.mkdir(path.dirname(path.join(work, extra.rel)), { recursive: true });
        await run.file(extra.file, extra.rel, false);
      }
    }
    const manifest = { version: 1, createdAt: now.toISOString(), sources: sources.map((s) => s.label), files: run.files };
    await fsp.writeFile(path.join(work, MANIFEST), zlib.gzipSync(JSON.stringify(manifest)));
    await fsp.rename(work, path.join(root, name));
  } catch (err) {
    await fsp.rm(work, { recursive: true, force: true });
    throw err;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  pruned.push(...(await prune(dest, { keep, capBytes })));
  return { snapshot: name, ...run.stats, skippedSample: run.skippedSample, pruned };
}

// ---------- status ----------

// The backup service writes its state here, in Roost's data folder, and the
// Roost web app reads it for the dashboard and the setup checklist.
function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(dataDir, status) {
  const file = path.join(dataDir, STATUS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

const HOUR = 60 * 60 * 1000;
const LATE_AFTER = 50 * HOUR; // two missed nights
const STOPPED_AFTER = 30 * 60 * 1000; // the service checks in every 10 minutes

// One word for the dashboard: how the backups are doing.
function summarize(status, now = Date.now()) {
  if (!status) return { state: 'off' };
  const out = { lastOk: status.lastOk || null, next: status.next || null };
  if (now - Date.parse(status.updatedAt) > STOPPED_AFTER) return { ...out, state: 'stopped' };
  if (status.running) return { ...out, state: 'running', progress: status.progress || null };
  if (!status.drive || !status.drive.ok) return { ...out, state: 'drive', message: status.drive ? status.drive.message : 'Backup drive not found' };
  if (status.last && !status.last.ok) return { ...out, state: 'failed', message: status.last.error };
  if (!status.lastOk) return { ...out, state: 'none' };
  if (now - Date.parse(status.lastOk) > LATE_AFTER) return { ...out, state: 'late' };
  return { ...out, state: 'ok' };
}

module.exports = {
  ROOT, MANIFEST, STATUS_FILE, REBUILDABLE, DEFAULT_KEEP,
  checkDrive, listSnapshots, toPrune, prune, readManifest, runBackup,
  readStatus, writeStatus, summarize, snapshotName,
};
