'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createServer } = require('../src/server');
const backup = require('../src/backup');
const restore = require('../src/restore');
const cli = require('../src/restore-cli');
const { setUpTwoStep } = require('./helpers');

let root;
let server;
let base;
let adminCookie;
let samCookie;
let sam;
let nestDir;
let dataDir;
let drive;
let night;

const write = (file, content, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-restore-'));
  dataDir = path.join(root, 'data');
  nestDir = path.join(root, 'nest');
  drive = path.join(root, 'drive');
  fs.mkdirSync(drive);
  server = createServer({ dataDir, nestDir, backupDir: drive, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, adminCookie);
  const made = await call('POST', '/api/admin/users', { username: 'sam', displayName: 'Sam', password: 'sam sam sam' }, adminCookie);
  sam = made.body.user;
  samCookie = (await call('POST', '/api/login', { username: 'sam', password: 'sam sam sam' })).cookie;

  // Sam's files as they were the night of the backup.
  const home = path.join(nestDir, `sam_${sam.id}`, 'files');
  const old = new Date('2026-03-04T10:00:00Z');
  write(path.join(home, 'Holiday', 'beach.jpg'), Buffer.alloc(30000, 7), old);
  write(path.join(home, 'Holiday', 'Day 2', 'notes.txt'), 'sunny\n'.repeat(2000), old);
  write(path.join(home, 'cv.txt'), 'curriculum vitae\n'.repeat(1000), old);
  write(path.join(dataDir, 'extra.json'), '{"keep":true}'.repeat(1000));
  write(path.join(root, 'appdata', 'jellyfin', 'config.xml'), '<jellyfin/>'.repeat(1000));

  backup.checkDrive(drive, { allowSameDrive: true });
  const r = await backup.runBackup({
    dest: drive,
    sources: [{ label: 'Nest', dir: nestDir }, { label: 'Roost', dir: dataDir, skip: (n) => n === 'roost.json' || n === 'nest.db' || n.startsWith('nest.db') }, { label: 'App settings', dir: path.join(root, 'appdata') }],
    now: new Date('2026-10-08T03:04:00'),
  });
  night = r.snapshot;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

const admin = (method, url, body) => call(method, url, body, adminCookie);

async function nestUpload(cookie, parent, name, data) {
  const buf = Buffer.from(data);
  const start = await call('POST', '/api/nest/uploads', { parent, name, size: buf.length }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  if (start.body.done) return;
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: buf });
  assert.equal(res.status, 200);
}
const browse = (p = '', n = night) => admin('GET', `/api/admin/backup/browse?${new URLSearchParams({ snapshot: n, path: p })}`);
const download = (p, n = night, cookie = adminCookie) => fetch(`${base}/api/admin/backup/download?${new URLSearchParams({ snapshot: n, path: p })}`, { headers: { Cookie: cookie } });

async function waitForJob() {
  for (let i = 0; i < 100; i++) {
    const { job } = (await admin('GET', '/api/admin/backup/restore')).body;
    if (job && !job.running) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('restore never finished');
}

test('a night reads like a folder tree, with sizes', async () => {
  const n = await new restore.Backups(drive).night(night);
  assert.equal(n.kind('Nest'), 'folder');
  assert.equal(n.kind(`Nest/sam_${sam.id}/files/cv.txt`), 'file');
  assert.equal(n.kind('Nope'), null);
  const files = n.list(`Nest/sam_${sam.id}/files`);
  assert.deepEqual(files.folders.map((f) => [f.name, f.files]), [['Holiday', 2]]);
  assert.deepEqual(files.files.map((f) => f.name), ['cv.txt']);
  assert.equal(n.list('').folders.length, 3);
  assert.equal(n.under(`Nest/sam_${sam.id}/files/Holiday`).length, 2);
  assert.equal(n.under('Nest').length, 3);
  assert.equal(n.under('App settings').length, 1);
  assert.ok(n.count >= 5 && n.bytes > 0);
});

test('bad snapshot names and paths never reach the drive', async () => {
  const backups = new restore.Backups(drive);
  for (const name of ['../etc', '2026-10-08 0304/../..', '', 'Roost Backups', `${night}/x`]) assert.equal(await backups.night(name), null, name);
  assert.equal(restore.cleanPath('a/../b'), null);
  assert.equal(restore.cleanPath('/a//b/'), 'a/b');
  assert.equal((await browse('Nest/../..')).status, 404);
  assert.equal((await download('../../etc/passwd')).status, 404);
  assert.equal((await browse('', '../x')).status, 404);
});

test('only admins browse, download or restore', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/admin/backup/browse'],
    ['GET', `/api/admin/backup/download?snapshot=${encodeURIComponent(night)}&path=Nest`],
    ['POST', '/api/admin/backup/restore', { snapshot: night, path: 'Nest' }],
    ['GET', '/api/admin/backup/restore'],
  ]) {
    assert.equal((await call(method, url, body)).status, 401, url);
    assert.equal((await call(method, url, body, samCookie)).status, 403, url);
  }
});

test('browsing lists nights and shows people by name', async () => {
  const top = (await browse()).body;
  assert.equal(top.available, true);
  assert.deepEqual(top.folders.map((f) => f.name), ['App settings', 'Nest', 'Roost']);
  assert.equal(top.nights[0].name, night);
  assert.ok(top.snapshot.files >= 5);
  const nest = (await browse('Nest')).body;
  assert.equal(nest.folders[0].label, 'Sam');
  assert.equal(nest.folders[0].restoreFor, null);
  const mine = (await browse(`Nest/sam_${sam.id}`)).body;
  assert.equal(mine.folders[0].name, 'files');
  assert.equal(mine.folders[0].restoreFor, 'Sam');
  const files = (await browse(`Nest/sam_${sam.id}/files`)).body;
  assert.equal(files.restoreTo.name, 'Sam');
  assert.equal(files.files[0].restoreFor, 'Sam');
  assert.equal(files.folders[0].restoreFor, 'Sam');
  const settings = (await browse('App settings/jellyfin')).body;
  assert.equal(settings.files[0].restoreFor, null);
  assert.equal(settings.restoreTo, null);
});

test('without a mounted drive Roost says so', async () => {
  const lone = createServer({ dataDir: path.join(root, 'lone'), probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => lone.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${lone.address().port}`;
    const mk = await fetch(`${url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'adm', password: 'password1' }) });
    const cookie = mk.headers.get('set-cookie').split(';')[0];
    const call2 = async (m, u, b) => { const r = await fetch(url + u, { method: m, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
    await setUpTwoStep(call2, cookie);
    const res = await call2('GET', '/api/admin/backup/browse');
    assert.deepEqual([res.body.available, res.body.reason], [false, 'not-mounted']);
  } finally {
    lone.close();
  }
});

test('a file downloads as it was, gzipped or not', async () => {
  const text = await download(`Nest/sam_${sam.id}/files/cv.txt`);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-disposition'), /cv\.txt/);
  assert.equal(Buffer.from(await text.arrayBuffer()).toString(), 'curriculum vitae\n'.repeat(1000));
  const photo = await download(`Nest/sam_${sam.id}/files/Holiday/beach.jpg`);
  assert.equal(Number(photo.headers.get('content-length')), 30000);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.alloc(30000, 7));
});

test('a folder downloads as a valid zip of the files as they were', async () => {
  const res = await download(`Nest/sam_${sam.id}/files/Holiday`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, Number(res.headers.get('content-length')));
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const seen = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    assert.equal(zlib.crc32(data), crc, name);
    seen[name] = data;
    p += 46 + nameLen + buf.readUInt16LE(p + 30);
  }
  assert.deepEqual(Object.keys(seen).sort(), ['Holiday/Day 2/notes.txt', 'Holiday/beach.jpg']);
  // The gzipped file went in uncompressed, at its original size.
  assert.equal(seen['Holiday/Day 2/notes.txt'].toString(), 'sunny\n'.repeat(2000));
});

test('restoring puts files in a new folder in the person’s Nest and touches nothing else', async () => {
  const mine = async () => (await call('GET', '/api/nest/folders/root', null, samCookie)).body;
  const open = async (id) => (await call('GET', `/api/nest/folders/${id}`, null, samCookie)).body.items;
  // Sam's Nest has since gotten a different cv.txt (this replaces the backed-up one on disk,
  // as if he had saved over it); the restore must leave it alone.
  fs.rmSync(path.join(nestDir, `sam_${sam.id}`, 'files', 'cv.txt'));
  await nestUpload(samCookie, 'root', 'cv.txt', 'new');

  const start = await admin('POST', '/api/admin/backup/restore', { snapshot: night, path: `Nest/sam_${sam.id}/files/Holiday` });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const job = await waitForJob();
  assert.equal(job.error, null);
  assert.equal(job.files, 2);
  assert.equal(job.folder, `Restored from backup ${night}`);

  const top = (await mine());
  const names = top.items.map((i) => i.name).sort();
  assert.deepEqual(names, [`Restored from backup ${night}`, 'cv.txt'].sort());
  assert.equal(fs.readFileSync(path.join(nestDir, `sam_${sam.id}`, 'files', 'cv.txt'), 'utf8'), 'new');

  const folder = top.items.find((i) => i.kind === 'folder');
  const inside = await open(folder.id);
  assert.deepEqual(inside.map((i) => i.name), ['Holiday']);
  const holiday = await open(inside[0].id);
  assert.deepEqual(holiday.map((i) => i.name).sort(), ['Day 2', 'beach.jpg']);
  const restoredFile = path.join(nestDir, `sam_${sam.id}`, 'files', `Restored from backup ${night}`, 'Holiday', 'Day 2', 'notes.txt');
  assert.equal(fs.readFileSync(restoredFile, 'utf8'), 'sunny\n'.repeat(2000));
  // Dates come back too, and Sam's storage usage counts the new files.
  assert.equal(fs.statSync(restoredFile).mtime.toISOString(), '2026-03-04T10:00:00.000Z');
  assert.ok((await mine()).storage.nestBytes >= 30000 + 12000);

  // Restoring again makes another folder instead of merging into the first.
  await admin('POST', '/api/admin/backup/restore', { snapshot: night, path: `Nest/sam_${sam.id}/files/cv.txt` });
  const second = await waitForJob();
  assert.equal(second.folder, `Restored from backup ${night} (1)`);
  const cv = path.join(nestDir, `sam_${sam.id}`, 'files', second.folder, 'cv.txt');
  assert.equal(fs.readFileSync(cv, 'utf8'), 'curriculum vitae\n'.repeat(1000));
});

test('only Nest files restore into Nest, and a full drive refuses before anything is made', async () => {
  const other = await admin('POST', '/api/admin/backup/restore', { snapshot: night, path: 'App settings/jellyfin' });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /Download/);
  assert.equal((await admin('POST', '/api/admin/backup/restore', { snapshot: night, path: 'Nest/nobody_1/files' })).status, 404);
  assert.equal((await admin('POST', '/api/admin/backup/restore', { snapshot: '../x', path: 'Nest' })).status, 404);

  // Sam's limit is now below what the restore needs.
  const before = fs.readdirSync(path.join(nestDir, `sam_${sam.id}`, 'files')).sort();
  const realLimit = server.nest.limitOf;
  server.nest.limitOf = () => ({ limitBytes: 1000, otherBytes: 0 });
  const refused = await admin('POST', '/api/admin/backup/restore', { snapshot: night, path: `Nest/sam_${sam.id}/files/Holiday` });
  server.nest.limitOf = realLimit;
  assert.equal(refused.status, 413);
  assert.match(refused.body.error, /Not enough space/);
  assert.deepEqual(fs.readdirSync(path.join(nestDir, `sam_${sam.id}`, 'files')).sort(), before);
});

// ---------- the command line ----------

const lines = () => {
  const out = [];
  return { out, say: (t) => out.push(t) };
};

test('the command line lists and restores a whole night, keeping layout and dates', async () => {
  const log = lines();
  assert.equal(await cli.run(['list', '--from', drive], { out: log.say }), 0);
  assert.match(log.out.join('\n'), new RegExp(`${night}\\s+\\d+ files`));

  const out = path.join(root, 'out-all');
  assert.equal(await cli.run(['restore', night, out, '--from', drive], { out: log.say }), 0);
  const cv = path.join(out, 'Nest', `sam_${sam.id}`, 'files', 'cv.txt');
  assert.equal(fs.readFileSync(cv, 'utf8'), 'curriculum vitae\n'.repeat(1000));
  assert.equal(fs.statSync(cv).mtime.toISOString(), '2026-03-04T10:00:00.000Z');
  assert.ok(fs.existsSync(path.join(out, 'App settings', 'jellyfin', 'config.xml')));
  assert.ok(fs.existsSync(path.join(out, 'Roost', 'extra.json')));
});

test('restoring part of a night keeps the picked folder’s name', async () => {
  const out = path.join(root, 'out-part');
  assert.equal(await cli.run(['restore', night, out, `Nest/sam_${sam.id}/files/Holiday`, '--from', drive], { out: () => {} }), 0);
  assert.deepEqual(fs.readdirSync(out), ['Holiday']);
  assert.ok(fs.existsSync(path.join(out, 'Holiday', 'Day 2', 'notes.txt')));
});

test('the command line never overwrites: it refuses, or moves the old folder aside after a confirm', async () => {
  const out = path.join(root, 'out-existing');
  write(path.join(out, 'precious.txt'), 'do not lose me');
  const log = lines();

  // 1. Refused.
  assert.equal(await cli.run(['restore', night, out, '--from', drive], { out: log.say }), 1);
  assert.match(log.out.join('\n'), /never overwrites/);
  assert.equal(fs.readFileSync(path.join(out, 'precious.txt'), 'utf8'), 'do not lose me');

  // 2. --replace but the answer isn't "restore": nothing changes.
  assert.equal(await cli.run(['restore', night, out, '--replace', '--from', drive], { out: log.say, confirm: async () => 'no' }), 1);
  assert.equal(fs.readFileSync(path.join(out, 'precious.txt'), 'utf8'), 'do not lose me');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('out-existing.before')), []);

  // 3. Confirmed: the old folder is kept beside it, the restore goes in fresh.
  let asked = '';
  assert.equal(await cli.run(['restore', night, out, '--replace', '--from', drive], { out: log.say, confirm: async (q) => { asked = q; return 'restore'; } }), 0);
  assert.match(asked, /nothing is deleted/);
  const aside = fs.readdirSync(root).filter((n) => n.startsWith('out-existing.before-restore-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(root, aside[0], 'precious.txt'), 'utf8'), 'do not lose me');
  assert.ok(fs.existsSync(path.join(out, 'Nest')));
  assert.ok(!fs.existsSync(path.join(out, 'precious.txt')));
});

test('the command line refuses odd targets and unknown backups', async () => {
  const log = lines();
  assert.equal(await cli.run(['restore', night, path.join(drive, 'inside'), '--from', drive], { out: log.say }), 1);
  assert.match(log.out.join('\n'), /not the backup drive/);
  assert.equal(await cli.run(['restore', 'no such night', path.join(root, 'x'), '--from', drive], { out: log.say }), 1);
  assert.equal(await cli.run(['restore', night, path.join(root, 'x'), 'Nope/Nothing', '--from', drive], { out: log.say }), 1);
  assert.equal(await cli.run(['list', '--from', path.join(root, 'empty')], { out: log.say }), 1);
  assert.equal(fs.existsSync(path.join(root, 'x')), false);
});

test('extract never overwrites a file that is already there', async () => {
  const n = await new restore.Backups(drive).night(night);
  const out = path.join(root, 'out-clash');
  write(path.join(out, 'cv.txt'), 'mine');
  await assert.rejects(restore.extract(n, n.under(`Nest/sam_${sam.id}/files/cv.txt`), out, { base: `Nest/sam_${sam.id}/files` }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(out, 'cv.txt'), 'utf8'), 'mine');
});
