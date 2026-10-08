'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const backup = require('../src/backup');
const service = require('../src/backup-service');

let tmp;
let n = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-backup-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A fresh source folder and backup drive for each test.
function world() {
  const root = path.join(tmp, String(n++));
  const src = path.join(root, 'src');
  const dest = path.join(root, 'drive');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest);
  return { root, src, dest };
}

function write(file, content, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

const at = (s) => new Date(s);
const snap = (dest, name, ...rel) => path.join(dest, backup.ROOT, name, ...rel);
const ino = (file) => fs.statSync(file).ino;

test('a snapshot looks like a full copy, with text stored gzipped', async () => {
  const { src, dest } = world();
  const photo = Buffer.alloc(50000, 7);
  const notes = 'shopping list\n'.repeat(1000);
  write(path.join(src, 'raven', 'files', 'photo.jpg'), photo);
  write(path.join(src, 'raven', 'files', 'notes.txt'), notes);
  write(path.join(src, 'raven', 'files', 'tiny.txt'), 'hi');
  fs.mkdirSync(path.join(src, 'raven', 'files', 'Empty'));

  const r = await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-08T03:00') });
  assert.equal(r.snapshot, '2026-10-08 0300');
  assert.equal(r.files, 3);
  assert.equal(r.compressed, 1);
  assert.deepEqual(fs.readFileSync(snap(dest, r.snapshot, 'Nest', 'raven', 'files', 'photo.jpg')), photo);
  assert.equal(zlib.gunzipSync(fs.readFileSync(snap(dest, r.snapshot, 'Nest', 'raven', 'files', 'notes.txt.gz'))).toString(), notes);
  // Too small to be worth compressing.
  assert.equal(fs.readFileSync(snap(dest, r.snapshot, 'Nest', 'raven', 'files', 'tiny.txt'), 'utf8'), 'hi');
  assert.ok(fs.statSync(snap(dest, r.snapshot, 'Nest', 'raven', 'files', 'Empty')).isDirectory());

  const manifest = await backup.readManifest(snap(dest, r.snapshot));
  const notesEntry = manifest.files.find((f) => f[0] === 'Nest/raven/files/notes.txt');
  assert.equal(notesEntry[1], notes.length);
  assert.equal(notesEntry[4], 1);
});

test('the next night links unchanged files and copies only what changed', async () => {
  const { src, dest } = world();
  const old = at('2026-10-01T12:00');
  write(path.join(src, 'a.jpg'), Buffer.alloc(20000, 1), old);
  write(path.join(src, 'b.jpg'), Buffer.alloc(20000, 2), old);
  const first = await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-08T03:00') });

  write(path.join(src, 'b.jpg'), Buffer.alloc(30000, 3));
  write(path.join(src, 'c.jpg'), Buffer.alloc(10000, 4));
  const second = await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-09T03:00') });

  assert.equal(second.linked, 1);
  assert.equal(second.written, 40000);
  assert.equal(ino(snap(dest, first.snapshot, 'Nest', 'a.jpg')), ino(snap(dest, second.snapshot, 'Nest', 'a.jpg')));
  assert.notEqual(ino(snap(dest, first.snapshot, 'Nest', 'b.jpg')), ino(snap(dest, second.snapshot, 'Nest', 'b.jpg')));
  // Last night's copy is untouched.
  assert.equal(fs.statSync(snap(dest, first.snapshot, 'Nest', 'b.jpg')).size, 20000);
});

test('identical files are stored once', async () => {
  const { src, dest } = world();
  const photo = Buffer.alloc(40000, 9);
  write(path.join(src, 'raven', 'beach.jpg'), photo);
  write(path.join(src, 'sam', 'beach copy.jpg'), photo);
  const r = await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-08T03:00') });
  assert.equal(r.deduped, 1);
  assert.equal(r.written, 40000);
  assert.equal(ino(snap(dest, r.snapshot, 'Nest', 'raven', 'beach.jpg')), ino(snap(dest, r.snapshot, 'Nest', 'sam', 'beach copy.jpg')));
});

test('a file renamed since last night is linked, not copied again', async () => {
  const { src, dest } = world();
  write(path.join(src, 'old name.jpg'), Buffer.alloc(30000, 5));
  await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-08T03:00') });
  fs.renameSync(path.join(src, 'old name.jpg'), path.join(src, 'new name.jpg'));
  const r = await backup.runBackup({ dest, sources: [{ label: 'Nest', dir: src }], now: at('2026-10-09T03:00') });
  assert.equal(r.written, 0);
  assert.equal(r.deduped, 1);
});

test('a text file next to its own .gz name is stored as is', async () => {
  const { src, dest } = world();
  const text = 'x'.repeat(10000);
  write(path.join(src, 'log.txt'), text);
  write(path.join(src, 'log.txt.gz'), zlib.gzipSync('other'));
  const r = await backup.runBackup({ dest, sources: [{ label: 'S', dir: src }], now: at('2026-10-08T03:00') });
  assert.equal(fs.readFileSync(snap(dest, r.snapshot, 'S', 'log.txt'), 'utf8'), text);
  assert.equal(zlib.gunzipSync(fs.readFileSync(snap(dest, r.snapshot, 'S', 'log.txt.gz'))).toString(), 'other');
});

test('keeps the newest of each of the last 7 days and 4 weeks', () => {
  const list = [];
  // Two backups a day for 60 days, newest first.
  for (let d = 0; d < 60; d++) {
    for (const h of [15, 3]) list.push({ name: `${d}-${h}`, at: new Date(2026, 9, 30 - d, h) });
  }
  const drop = new Set(backup.toPrune(list, { daily: 7, weekly: 4 }));
  const kept = list.filter((s) => !drop.has(s.name));
  // 7 days, plus the newest of the 4 weeks (3 of them already among the days or
  // overlapping them); never more than 11.
  assert.ok(kept.length >= 7 && kept.length <= 11, String(kept.length));
  assert.equal(kept[0].name, list[0].name);
  // Only the later backup of each day survives.
  assert.ok(kept.every((s) => s.at.getHours() === 15));
  // Nothing older than about 4 weeks.
  assert.ok(kept.every((s) => list[0].at - s.at < 29 * 86400000));
});

test('old snapshots are pruned after a run', async () => {
  const { src, dest } = world();
  write(path.join(src, 'a.txt'), 'a');
  for (let d = 1; d <= 9; d++) {
    await backup.runBackup({ dest, sources: [{ label: 'S', dir: src }], keep: { daily: 3, weekly: 1 }, now: new Date(2026, 9, d, 3) });
  }
  const names = backup.listSnapshots(dest).map((s) => s.name);
  assert.deepEqual(names, ['2026-10-09 0300', '2026-10-08 0300', '2026-10-07 0300']);
});

test('caches and logs in app settings are skipped', async () => {
  const { src, dest } = world();
  write(path.join(src, 'jellyfin', 'config', 'data', 'library.db'), 'db');
  write(path.join(src, 'jellyfin', 'cache', 'images', 'poster.jpg'), 'poster');
  write(path.join(src, 'jellyfin', 'config', 'log', 'today.log'), 'log');
  const [, , settings] = service.sources({ dataDir: path.join(src, 'none'), nestDir: path.join(src, 'none2'), appDataDir: src });
  const r = await backup.runBackup({ dest, sources: [settings], now: at('2026-10-08T03:00') });
  assert.equal(r.files, 1);
  assert.ok(fs.existsSync(snap(dest, r.snapshot, 'App settings', 'jellyfin', 'config', 'data', 'library.db')));
  assert.ok(!fs.existsSync(snap(dest, r.snapshot, 'App settings', 'jellyfin', 'cache')));
});

test('Roost’s data is backed up once, with a safe copy of Nest’s database', async () => {
  const { root, dest } = world();
  const appData = path.join(root, 'AppData');
  const dataDir = path.join(appData, 'roost');
  const nestDir = path.join(root, 'nest');
  write(path.join(dataDir, 'roost.json'), '{}');
  write(path.join(nestDir, 'raven_1', 'files', 'a.txt'), 'a');
  write(path.join(nestDir, 'raven_1', '.uploads', 'half'), 'half');
  write(path.join(appData, 'jellyfin', 'config.xml'), '<x/>');
  const db = new DatabaseSync(path.join(dataDir, 'nest.db'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\');');

  const r = await backup.runBackup({
    dest,
    sources: service.sources({ dataDir, nestDir, appDataDir: appData }),
    extras: service.nestDatabase(dataDir),
    now: at('2026-10-08T03:00'),
  });
  db.close();
  const manifest = await backup.readManifest(snap(dest, r.snapshot));
  const paths = manifest.files.map((f) => f[0]).sort();
  assert.deepEqual(paths, ['App settings/jellyfin/config.xml', 'Nest/raven_1/files/a.txt', 'Roost/nest.db', 'Roost/roost.json']);
  // Databases shrink well, so it is stored gzipped.
  const restored = path.join(root, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(snap(dest, r.snapshot, 'Roost', 'nest.db.gz'))));
  const copy = new DatabaseSync(restored);
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'kept');
  copy.close();
});

test('the drive must not be the drive the data is on', () => {
  const { src, dest } = world();
  const d = backup.checkDrive(dest, { sameDriveAs: [src] });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'same-drive');
  assert.equal(backup.checkDrive(path.join(dest, 'unplugged')).reason, 'missing');
  const ok = backup.checkDrive(dest, { sameDriveAs: [src], allowSameDrive: true });
  assert.equal(ok.ok, true);
  assert.ok(ok.id);
  // The same drive keeps its id.
  assert.equal(backup.checkDrive(dest, { allowSameDrive: true }).id, ok.id);
});

test('the dashboard summary', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const fresh = { updatedAt: '2026-10-09T11:55:00Z', drive: { ok: true } };
  assert.equal(backup.summarize(null).state, 'off');
  assert.equal(backup.summarize({ ...fresh }, now).state, 'none');
  assert.equal(backup.summarize({ ...fresh, lastOk: '2026-10-09T03:04:00Z', last: { ok: true } }, now).state, 'ok');
  assert.equal(backup.summarize({ ...fresh, lastOk: '2026-10-07T03:04:00Z', last: { ok: true } }, now).state, 'late');
  assert.equal(backup.summarize({ ...fresh, lastOk: '2026-10-08T03:04:00Z', last: { ok: false, error: 'The backup drive is full' } }, now).state, 'failed');
  assert.equal(backup.summarize({ ...fresh, drive: { ok: false, message: 'Backup drive not found' } }, now).state, 'drive');
  assert.equal(backup.summarize({ ...fresh, running: true }, now).state, 'running');
  assert.equal(backup.summarize({ ...fresh, updatedAt: '2026-10-09T10:00:00Z' }, now).state, 'stopped');
});

test('next run is the coming 3:00', () => {
  const from = new Date(2026, 9, 8, 2, 59);
  assert.equal(service.nextAt('03:00', from).getTime(), new Date(2026, 9, 8, 3, 0).getTime());
  assert.equal(service.nextAt('03:00', new Date(2026, 9, 8, 3, 0)).getTime(), new Date(2026, 9, 9, 3, 0).getTime());
});
