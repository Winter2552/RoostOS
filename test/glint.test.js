'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let nestDir;
let admin;
let mia;
let miaId;
let sam;

// The smallest JPEG start a preview needs to pass the server's check.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-glint-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  // Mia has Glint but not Nest: her photos still live in Nest's storage.
  const made = await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', limitGb: 1, apps: ['glint'] }, admin);
  miaId = made.body.user.id;
  mia = (await call('POST', '/api/login', { username: 'mia', password: 'password1' })).cookie;
  await call('POST', '/api/admin/users', { username: 'sam', password: 'password1', apps: ['glint', 'nest'] }, admin);
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

async function upload(cookie, name, data, extra = {}) {
  const buf = Buffer.from(data);
  const start = await call('POST', '/api/glint/uploads', { name, size: buf.length, type: 'image/jpeg', ...extra }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const res = await fetch(`${base}/api/glint/uploads/${start.body.id}?offset=0`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  return out.item;
}

async function preview(cookie, id, query, body = JPEG) {
  const res = await fetch(`${base}/api/glint/photos/${id}/preview?${query}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'image/jpeg' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

const photos = async (cookie, q = '') => (await call('GET', `/api/glint/photos${q}`, null, cookie)).body;
const miaHome = () => path.join(nestDir, `mia_${miaId}`);

test('Glint needs a signed-in user with access, and its card opens the built-in page', async () => {
  assert.equal((await call('GET', '/api/glint/photos')).status, 401);
  const users = await call('GET', '/api/admin/users', null, admin);
  const id = users.body.users.find((u) => u.username === 'sam').id;
  await call('PATCH', `/api/admin/users/${id}`, { apps: ['nest'] }, admin);
  assert.equal((await call('GET', '/api/glint/photos', null, sam)).status, 403);
  await call('PATCH', `/api/admin/users/${id}`, { apps: ['glint', 'nest'] }, admin);
  assert.equal((await call('GET', '/api/glint/photos', null, sam)).status, 200);
  const apps = (await call('GET', '/api/apps', null, mia)).body.apps;
  assert.deepEqual(apps.map((a) => [a.id, a.url]), [['glint', '#/glint']]);
});

test('uploads land in Photos/<year> in Nest, and previews and dates come from the browser', async () => {
  const item = await upload(mia, 'IMG_0001.jpg', 'photo one', { year: 2019 });
  assert.equal(fs.readFileSync(path.join(miaHome(), 'files', 'Photos', '2019', 'IMG_0001.jpg'), 'utf8'), 'photo one');

  let page = await photos(mia);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, item.id);
  assert.equal(page.items[0].thumb, 0);
  assert.equal(page.storage.nestBytes, 9);

  const taken = Date.UTC(2019, 6, 4, 12);
  const d = await preview(mia, item.id, `taken=${taken}&w=4032&h=3024`);
  assert.equal(d.status, 200);
  assert.deepEqual([d.body.item.taken, d.body.item.w, d.body.item.h, d.body.item.thumb], [taken, 4032, 3024, 1]);

  const thumb = await fetch(`${base}/api/glint/thumbs/${item.id}`, { headers: { Cookie: mia } });
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  assert.match(thumb.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), JPEG);

  // Not a JPEG: refused. Empty: the browser couldn't draw one, so stop asking.
  assert.equal((await preview(mia, item.id, '', Buffer.from('<svg/>'))).status, 400);
  const v = await upload(mia, 'clip.heic', 'heic data', { type: '' });
  const none = await preview(mia, v.id, 'taken=0', Buffer.alloc(0));
  assert.equal(none.body.item.thumb, 2);
  assert.equal(none.body.item.taken, 0);
});

test('the timeline is newest first and pages without gaps', async () => {
  const before = await photos(sam);
  assert.equal(before.total, 0);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const it = await upload(sam, `p${i}.jpg`, `photo ${i}`);
    await preview(sam, it.id, `taken=${Date.UTC(2020, 0, 1 + i)}`);
    ids.push(it.id);
  }
  const page = await photos(sam);
  assert.deepEqual(page.items.map((p) => p.id), [...ids].reverse());
  assert.equal(page.next, null);
  // Paging from the third photo carries on with the fourth.
  const third = page.items[2];
  const rest = await photos(sam, `?before=${third.taken}.${third.id}`);
  assert.deepEqual(rest.items.map((p) => p.id), [ids[1], ids[0]]);
});

test('photos put in Nest show up in Glint; other files do not', async () => {
  const start = await call('POST', '/api/nest/uploads', { parent: 'root', name: 'beach.PNG', size: 3 }, sam);
  await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, { method: 'PUT', headers: { Cookie: sam }, body: 'png' });
  const doc = await call('POST', '/api/nest/uploads', { parent: 'root', name: 'notes.txt', size: 2, type: 'text/plain' }, sam);
  await fetch(`${base}/api/nest/uploads/${doc.body.id}?offset=0`, { method: 'PUT', headers: { Cookie: sam }, body: 'hi' });
  const names = (await photos(sam)).items.map((p) => p.name);
  assert.ok(names.includes('beach.PNG'));
  assert.ok(!names.includes('notes.txt'));
});

test('photos show in the page, but anything else only downloads', async () => {
  const item = (await photos(mia)).items.find((p) => p.name === 'IMG_0001.jpg');
  const res = await fetch(`${base}/api/glint/media/${item.id}`, { headers: { Cookie: mia, Range: 'bytes=0-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await res.text(), 'photo');
  // A web page dressed as a photo is still sent as a download.
  const fake = await upload(mia, 'trick.jpg', '<script>alert(1)</script>', { type: 'text/html' });
  const sent = await fetch(`${base}/api/glint/media/${fake.id}`, { headers: { Cookie: mia } });
  assert.equal(sent.headers.get('content-type'), 'image/jpeg');
  assert.match(sent.headers.get('content-security-policy'), /sandbox/);
  const dl = await fetch(`${base}/api/glint/download/${item.id}`, { headers: { Cookie: mia } });
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  await call('POST', '/api/glint/trash', { ids: [fake.id] }, mia);
});

test('people only ever see their own photos', async () => {
  const item = (await photos(mia)).items[0];
  assert.equal((await fetch(`${base}/api/glint/media/${item.id}`, { headers: { Cookie: sam } })).status, 404);
  assert.equal((await fetch(`${base}/api/glint/thumbs/${item.id}`, { headers: { Cookie: sam } })).status, 404);
  assert.equal((await preview(sam, item.id, 'taken=1')).status, 404);
  assert.equal((await call('POST', '/api/glint/favourite', { ids: [item.id] }, sam)).status, 200);
  assert.equal((await photos(mia)).items[0].fav, false);
  const trashed = await call('POST', '/api/glint/trash', { ids: [item.id] }, sam);
  assert.deepEqual(trashed.body.trashed, []);
});

test('the duplicate check finds photos already uploaded', async () => {
  const res = await call('POST', '/api/glint/check', { files: [{ name: 'img_0001.JPG', size: 9 }, { name: 'IMG_0001.jpg', size: 10 }, { name: 'new.jpg', size: 9 }] }, mia);
  assert.deepEqual(res.body.exists, [true, false, false]);
});

test('the storage limit holds for Glint uploads', async () => {
  const res = await call('POST', '/api/glint/uploads', { name: 'huge.mov', size: 2 * 1024 ** 3, type: 'video/quicktime' }, mia);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /Not enough space/);
});

test('favourites and albums', async () => {
  const items = (await photos(sam)).items;
  const [a, b, c] = items;
  await call('POST', '/api/glint/favourite', { ids: [a.id, b.id] }, sam);
  await call('POST', '/api/glint/favourite', { ids: [b.id], on: false }, sam);
  assert.deepEqual((await photos(sam, '?fav=1')).items.map((p) => p.id), [a.id]);

  const made = await call('POST', '/api/glint/albums', { name: 'Holiday', ids: [b.id, c.id] }, sam);
  assert.equal(made.status, 201);
  assert.equal(made.body.album.count, 2);
  const album = made.body.album.id;
  assert.equal((await call('POST', `/api/glint/albums/${album}/add`, { ids: [b.id, a.id] }, sam)).body.added, 1);
  await call('POST', `/api/glint/albums/${album}/remove`, { ids: [c.id] }, sam);
  assert.deepEqual((await photos(sam, `?album=${album}`)).items.map((p) => p.id), [a.id, b.id]);
  await call('PATCH', `/api/glint/albums/${album}`, { name: 'Summer' }, sam);
  const list = (await call('GET', '/api/glint/albums', null, sam)).body.albums;
  assert.deepEqual(list.map((x) => [x.name, x.count, x.cover]), [['Summer', 2, a.id]]);
  // Albums are private too.
  assert.equal((await call('GET', `/api/glint/photos?album=${album}`, null, mia)).status, 404);
  assert.equal((await call('POST', `/api/glint/albums/${album}/add`, { ids: [a.id] }, mia)).status, 404);
  // Deleting an album keeps its photos.
  await call('DELETE', `/api/glint/albums/${album}`, null, sam);
  assert.equal((await call('GET', '/api/glint/albums', null, sam)).body.albums.length, 0);
  assert.equal((await photos(sam)).items.length, items.length);
});

test('deleted photos go to the trash, come back, and are gone for good with their preview', async () => {
  const item = (await photos(mia)).items.find((p) => p.name === 'IMG_0001.jpg');
  const album = (await call('POST', '/api/glint/albums', { name: 'Keep', ids: [item.id] }, mia)).body.album.id;
  await call('POST', '/api/glint/trash', { ids: [item.id] }, mia);
  assert.ok(!(await photos(mia)).items.some((p) => p.id === item.id));
  const trash = (await call('GET', '/api/glint/trash', null, mia)).body.items;
  assert.ok(trash.some((t) => t.id === item.id));
  assert.equal((await call('GET', '/api/glint/albums', null, mia)).body.albums[0].count, 0);

  await call('POST', '/api/glint/restore', { ids: [item.id] }, mia);
  const back = (await photos(mia)).items.find((p) => p.id === item.id);
  assert.equal(back.w, 4032); // the date, size and preview survive the trash
  assert.equal((await call('GET', '/api/glint/albums', null, mia)).body.albums[0].count, 1);

  await call('POST', '/api/glint/trash', { ids: [item.id] }, mia);
  const gone = await call('POST', '/api/glint/trash/delete', { ids: [item.id] }, mia);
  assert.deepEqual(gone.body.deleted, [item.id]);
  assert.ok(!fs.existsSync(path.join(miaHome(), '.glint', `${item.id}.jpg`)));
  assert.equal((await call('GET', '/api/glint/albums', null, mia)).body.albums.find((a) => a.id === album).count, 0);
  assert.equal((await fetch(`${base}/api/glint/thumbs/${item.id}`, { headers: { Cookie: mia } })).status, 404);
});

test("Glint's trash only empties photos, never other Nest files", async () => {
  const doc = await call('POST', '/api/nest/uploads', { parent: 'root', name: 'tax.pdf', size: 3, type: 'application/pdf' }, sam);
  const done = await (await fetch(`${base}/api/nest/uploads/${doc.body.id}?offset=0`, { method: 'PUT', headers: { Cookie: sam }, body: 'pdf' })).json();
  await call('POST', '/api/nest/trash', { ids: [done.item.id] }, sam);
  const photo = (await photos(sam)).items[0];
  await call('POST', '/api/glint/trash', { ids: [photo.id] }, sam);
  assert.deepEqual((await call('GET', '/api/glint/trash', null, sam)).body.items.map((t) => t.id), [photo.id]);
  await call('POST', '/api/glint/trash/delete', { all: true }, sam);
  const nestTrash = (await call('GET', '/api/nest/trash', null, sam)).body.items;
  assert.deepEqual(nestTrash.map((t) => t.name), ['tax.pdf']);
});
