'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createServer } = require('../src/server');
const { cleanName } = require('../src/nest');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let nestDir;
let admin;
let sam;
let samId;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-nest-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  const made = await call('POST', '/api/admin/users', { username: 'sam', password: 'password1', limitGb: 1 }, admin);
  samId = made.body.user.id;
  sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

async function upload(cookie, parent, name, data, extra = {}) {
  const buf = Buffer.from(data);
  const start = await call('POST', '/api/nest/uploads', { parent, name, size: buf.length, ...extra }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  if (start.body.done) return start.body.item;
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.done, true);
  return out.item;
}

const list = async (cookie, id = 'root', q = '') => (await call('GET', `/api/nest/folders/${id}${q}`, null, cookie)).body;
const samHome = () => path.join(nestDir, `sam_${samId}`);

test('names are made safe for every operating system', () => {
  assert.equal(cleanName('  a/b:c?.txt  '), 'a_b_c_.txt');
  assert.equal(cleanName('notes. '), 'notes');
  assert.equal(cleanName('CON.txt'), '_CON.txt');
  assert.equal(cleanName('..'), '');
});

test('Nest needs a signed-in user with access', async () => {
  assert.equal((await call('GET', '/api/nest/folders/root')).status, 401);
  const users = await call('GET', '/api/admin/users', null, admin);
  const id = users.body.users.find((u) => u.username === 'sam').id;
  await call('PATCH', `/api/admin/users/${id}`, { apps: ['jellyfin'] }, admin);
  assert.equal((await call('GET', '/api/nest/folders/root', null, sam)).status, 403);
  await call('PATCH', `/api/admin/users/${id}`, { apps: null }, admin);
  assert.equal((await call('GET', '/api/nest/folders/root', null, sam)).status, 200);
});

test('the Nest app card opens the built-in page', async () => {
  const apps = (await call('GET', '/api/apps', null, admin)).body.apps;
  assert.equal(apps.find((a) => a.id === 'nest').url, '#/nest');
  const status = (await call('GET', '/api/apps/status', null, admin)).body.status;
  assert.equal(status.nest, 'online');
});

test('folders, uploads and downloads', async () => {
  const f = await call('POST', '/api/nest/folders', { parent: 'root', name: 'Work' }, sam);
  assert.equal(f.status, 201);
  const again = await call('POST', '/api/nest/folders', { parent: 'root', name: 'work' }, sam);
  assert.equal(again.body.item.name, 'work (1)');

  const file = await upload(sam, f.body.item.id, 'notes.txt', 'hello nest');
  assert.equal(file.size, 10);
  assert.equal(fs.readFileSync(path.join(samHome(), 'files', 'Work', 'notes.txt'), 'utf8'), 'hello nest');

  const dup = await upload(sam, f.body.item.id, 'notes.txt', 'second');
  assert.equal(dup.name, 'notes (1).txt');

  const inside = await list(sam, f.body.item.id);
  assert.deepEqual(inside.items.map((i) => i.name), ['notes (1).txt', 'notes.txt']);
  assert.deepEqual(inside.path.map((c) => c.name), ['Work']);
  assert.equal(inside.storage.nestBytes, 16);

  const dl = await fetch(`${base}/api/nest/files/${file.id}`, { headers: { Cookie: sam } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="notes.txt"/);
  assert.equal(await dl.text(), 'hello nest');

  const part = await fetch(`${base}/api/nest/files/${file.id}`, { headers: { Cookie: sam, Range: 'bytes=6-' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'nest');

  // Other users can't see it.
  assert.equal((await fetch(`${base}/api/nest/files/${file.id}`, { headers: { Cookie: admin } })).status, 404);
});

test('folder uploads recreate the folders', async () => {
  const a = await upload(sam, 'root', 'a.txt', 'A', { path: 'Trip/Day 1' });
  const b = await upload(sam, 'root', 'b.txt', 'B', { path: 'Trip/Day 1' });
  const root = await list(sam);
  const trip = root.items.find((i) => i.name === 'Trip');
  const day = (await list(sam, trip.id)).items;
  assert.deepEqual(day.map((i) => i.name), ['Day 1']);
  const files = (await list(sam, day[0].id)).items.map((i) => i.id);
  assert.deepEqual(files.sort(), [a.id, b.id].sort());
});

test('uploads go in pieces and resume after a dropped piece', async () => {
  const data = Buffer.from('0123456789');
  const start = await call('POST', '/api/nest/uploads', { parent: 'root', name: 'big.bin', size: 10 }, sam);
  const put = (offset, body) => fetch(`${base}/api/nest/uploads/${start.body.id}?offset=${offset}`, {
    method: 'PUT', headers: { Cookie: sam }, body,
  });
  let r = await put(0, data.subarray(0, 4));
  assert.deepEqual(await r.json(), { received: 4 });
  // A piece sent again from the wrong place is told where to carry on.
  r = await put(0, data.subarray(0, 4));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).received, 4);
  r = await put(4, data.subarray(4));
  const done = await r.json();
  assert.equal(done.done, true);
  assert.equal(done.item.size, 10);
});

test('the storage limit is enforced', async () => {
  const r = await call('POST', '/api/nest/uploads', { parent: 'root', name: 'huge.iso', size: 2 * 1024 ** 3 }, sam);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /Not enough space/);
  assert.equal(r.body.code, 'over-limit');
});

test('rename, move and copy', async () => {
  const docs = (await call('POST', '/api/nest/folders', { parent: 'root', name: 'Docs' }, sam)).body.item;
  const inner = (await call('POST', '/api/nest/folders', { parent: docs.id, name: 'Inner' }, sam)).body.item;
  const file = await upload(sam, 'root', 'cv.pdf', 'pdf!');

  const renamed = await call('PATCH', `/api/nest/items/${file.id}`, { name: 'CV 2026.pdf' }, sam);
  assert.equal(renamed.body.item.name, 'CV 2026.pdf');

  const moved = await call('POST', '/api/nest/move', { ids: [file.id], parent: inner.id }, sam);
  assert.equal(moved.body.moved[0].from, 'root');
  assert.ok(fs.existsSync(path.join(samHome(), 'files', 'Docs', 'Inner', 'CV 2026.pdf')));

  const loop = await call('POST', '/api/nest/move', { ids: [docs.id], parent: inner.id }, sam);
  assert.equal(loop.status, 400);

  const copied = await call('POST', '/api/nest/copy', { ids: [file.id] }, sam);
  assert.equal(copied.body.items[0].name, 'Copy of CV 2026.pdf');
  assert.equal(fs.readFileSync(path.join(samHome(), 'files', 'Docs', 'Inner', 'Copy of CV 2026.pdf'), 'utf8'), 'pdf!');
});

test('trash, restore and delete forever', async () => {
  const box = (await call('POST', '/api/nest/folders', { parent: 'root', name: 'Box' }, sam)).body.item;
  const file = await upload(sam, box.id, 'keep.txt', 'keep');
  const before = (await list(sam)).storage.nestBytes;

  await call('POST', '/api/nest/trash', { ids: [box.id] }, sam);
  assert.ok(!(await list(sam)).items.some((i) => i.id === box.id));
  assert.ok(fs.existsSync(path.join(samHome(), 'trash', box.id, 'Box', 'keep.txt')));
  // Files in the trash still count, like Drive.
  assert.equal((await list(sam)).storage.nestBytes, before);
  assert.equal((await call('GET', `/api/nest/files/${file.id}`, null, sam)).status, 404);
  const bin = (await call('GET', '/api/nest/trash', null, sam)).body;
  assert.deepEqual(bin.items.map((i) => i.id), [box.id]);

  // A new folder takes the name; restoring picks another.
  await call('POST', '/api/nest/folders', { parent: 'root', name: 'Box' }, sam);
  const restored = await call('POST', '/api/nest/restore', { ids: [box.id] }, sam);
  assert.equal(restored.body.restored[0].name, 'Box (1)');
  assert.ok(fs.existsSync(path.join(samHome(), 'files', 'Box (1)', 'keep.txt')));
  assert.ok(!fs.existsSync(path.join(samHome(), 'trash', box.id)));

  await call('POST', '/api/nest/trash', { ids: [file.id] }, sam);
  const del = await call('POST', '/api/nest/trash/delete', { ids: [file.id] }, sam);
  assert.deepEqual(del.body.deleted, [file.id]);
  assert.equal(del.body.storage.nestBytes, before - 4);
  assert.ok(!fs.existsSync(path.join(samHome(), 'trash', file.id)));
});

test('the trash empties itself after 30 days', async () => {
  const file = await upload(sam, 'root', 'old.txt', 'old');
  await call('POST', '/api/nest/trash', { ids: [file.id] }, sam);
  await server.nest.sweep(Date.now() + 29 * 86400000);
  assert.ok((await call('GET', '/api/nest/trash', null, sam)).body.items.some((i) => i.id === file.id));
  await server.nest.sweep(Date.now() + 31 * 86400000);
  assert.ok(!(await call('GET', '/api/nest/trash', null, sam)).body.items.some((i) => i.id === file.id));
});

test('usage reaches the Roost storage page', async () => {
  const mine = (await call('GET', '/api/me/storage', null, sam)).body.storage;
  assert.equal(mine.usage.nest, (await list(sam)).storage.nestBytes);
});

test('folders download as a valid zip', async () => {
  const z = (await call('POST', '/api/nest/folders', { parent: 'root', name: 'Zipme' }, sam)).body.item;
  await call('POST', '/api/nest/folders', { parent: z.id, name: 'Sub' }, sam);
  await upload(sam, z.id, 'one.txt', 'first file');
  await upload(sam, z.id, 'two – ü.txt', 'second');
  const res = await fetch(`${base}/api/nest/zip?ids=${z.id}`, { headers: { Cookie: sam } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, Number(res.headers.get('content-length')));

  // Read the central directory and check every file's CRC against its data.
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    names.push(name);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    assert.equal(zlib.crc32(buf.subarray(dataAt, dataAt + size)), crc, name);
    p += 46 + nameLen + buf.readUInt16LE(p + 30);
  }
  assert.deepEqual(names.sort(), ['Zipme/', 'Zipme/Sub/', 'Zipme/one.txt', 'Zipme/two – ü.txt']);
});
