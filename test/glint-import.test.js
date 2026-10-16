'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { HttpError } = require('../src/http');
const { sidecarNames } = require('../src/glint-import');
const { setUpTwoStep } = require('./helpers');
const { makeZip } = require('./zipmaker');

let server;
let base;
let dataDir;
let nestDir;
let admin;
let mia;
let miaId;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-import-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  const made = await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', limitGb: 1, apps: ['glint'] }, admin);
  miaId = made.body.user.id;
  mia = (await call('POST', '/api/login', { username: 'mia', password: 'password1' })).cookie;
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

async function putZip(cookie, name, buf) {
  const start = await call('POST', '/api/glint/uploads', { name, size: buf.length, type: 'application/zip', importZip: true }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const res = await fetch(`${base}/api/glint/uploads/${start.body.id}?offset=0`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  assert.equal(res.status, 200);
}

async function finished(cookie) {
  for (let i = 0; i < 200; i++) {
    const s = (await call('GET', '/api/glint/import', null, cookie)).body;
    if (s.job && !s.job.running) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the move never finished');
}

const ts = (y, m, d) => String(Math.floor(Date.UTC(y, m - 1, d, 12) / 1000));
const meta = (y, m, d, extra = {}) => JSON.stringify({ photoTakenTime: { timestamp: ts(y, m, d) }, ...extra });
const G = 'Takeout/Google Photos/';
const miaHome = () => path.join(nestDir, `mia_${miaId}`);

test('finds the JSON beside a photo however Google named it', () => {
  assert.ok(sidecarNames('IMG_1.jpg').includes('img_1.jpg.json'));
  assert.ok(sidecarNames('IMG_1.jpg').includes('img_1.jpg.supplemental-metadata.json'));
  assert.ok(sidecarNames('IMG_1.jpg').includes('img_1.jpg.supplemental-metad.json'));
  assert.ok(sidecarNames('IMG_1-edited.jpg').includes('img_1.jpg.json'));
  assert.ok(sidecarNames('IMG_9(1).jpg').includes('img_9.jpg(1).json'));
  assert.ok(sidecarNames('IMG_9(1).jpg').includes('img_9.jpg.supplemental-metadata(1).json'));
  const long = `${'a'.repeat(60)}.jpg`;
  assert.ok(sidecarNames(long).includes(`${'a'.repeat(46)}.json`));
});

test('Move to Glint needs zips first', async () => {
  const r = await call('POST', '/api/glint/import/start', {}, mia);
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/glint/import')).status, 401);
});

test('moves a Takeout: right dates, albums, favourites, no repeats, no trash', async () => {
  const A = 'photo A bytes';
  await putZip(mia, 'takeout-001.zip', makeZip([
    { name: `${G}Photos from 2019/IMG_1.jpg`, data: A, deflate: true },
    { name: `${G}Photos from 2019/IMG_1.jpg.supplemental-metadata.json`, data: meta(2019, 7, 4, { favorited: true }) },
    { name: `${G}Photos from 2020/b.jpg`, data: 'photo B' },
    { name: `${G}Photos from 2020/b.jpg.json`, data: meta(2020, 3, 9) },
    { name: `${G}Photos from 2020/b-edited.jpg`, data: 'photo B edited' },
    { name: `${G}Photos from 2020/clip.mp4`, data: 'video C' },
    { name: `${G}Photos from 2020/clip.mp4.supplemental-metad.json`, data: meta(2020, 5, 1) },
    { name: `${G}Photos from 2020/gone.jpg`, data: 'photo gone' },
    { name: `${G}Photos from 2020/gone.jpg.json`, data: meta(2020, 5, 2, { trashed: true }) },
    { name: `${G}Photos from 2021/IMG_9(1).jpg`, data: 'photo nine' },
    { name: `${G}Photos from 2021/IMG_9.jpg(1).json`, data: meta(2021, 1, 2) },
    { name: `${G}Photos from 2021/nodate.png`, data: 'no json here' },
    { name: `${G}Trip to Rome/IMG_1.jpg`, data: A },
    { name: `${G}Trip to Rome/IMG_1.jpg.json`, data: meta(2019, 7, 4) },
    { name: `${G}Trip to Rome/metadata.json`, data: '{"title":"Trip to Rome"}' },
    { name: `${G}Trip to Rome/b.jpg`, data: 'photo B' },
    { name: `${G}Trip to Rome/b.jpg.json`, data: meta(2020, 3, 9) },
    { name: `${G}Trash/old.jpg`, data: 'in the bin' },
    { name: `${G}Photos from 2020/broken.jpg`, data: 'will be damaged' },
  ]));
  // Damage one file's data in the saved zip, so it fails its CRC check.
  const saved = path.join(miaHome(), 'files', 'Move to Glint', 'takeout-001.zip');
  const buf = fs.readFileSync(saved);
  buf[buf.indexOf('will be damaged')] ^= 0xff;
  fs.writeFileSync(saved, buf);

  assert.equal((await call('POST', '/api/glint/import/start', {}, mia)).status, 200);
  const s = await finished(mia);
  assert.equal(s.job.error, '');
  assert.deepEqual(s.counts, { moved: 5, nodate: 1, dup: 2, skipped: 2, problem: 1 });
  assert.match(s.problems[0].note, /damaged/);

  const page = (await call('GET', '/api/glint/photos', null, mia)).body;
  assert.equal(page.total, 6);
  const byName = Object.fromEntries(page.items.map((p) => [p.name, p]));
  assert.equal(byName['IMG_1.jpg'].taken, Date.UTC(2019, 6, 4, 12));
  assert.equal(byName['IMG_1.jpg'].fav, true);
  assert.equal(byName['b.jpg'].fav, false);
  assert.equal(byName['b-edited.jpg'].taken, Date.UTC(2020, 2, 9, 12)); // edited copies share the original's JSON
  assert.equal(byName['clip.mp4'].video, true);
  assert.equal(byName['clip.mp4'].taken, Date.UTC(2020, 4, 1, 12));
  assert.equal(byName['IMG_9(1).jpg'].taken, Date.UTC(2021, 0, 2, 12));
  assert.ok(!byName['gone.jpg'] && !byName['old.jpg'] && !byName['broken.jpg']);
  assert.ok(fs.existsSync(path.join(miaHome(), 'files', 'Photos', '2019', 'IMG_1.jpg')));
  assert.ok(fs.existsSync(path.join(miaHome(), 'files', 'Photos', '2020', 'clip.mp4')));
  assert.ok(!fs.existsSync(path.join(miaHome(), '.uploads', 'import-x')));

  // Only the trip is an album; year folders are not, and it holds the repeats too.
  const albums = (await call('GET', '/api/glint/albums', null, mia)).body.albums;
  assert.deepEqual(albums.map((a) => [a.name, a.count]), [['Trip to Rome', 2]]);

  // A date from Google is kept when the browser later sends the photo's own.
  const id = byName['IMG_1.jpg'].id;
  const d = await fetch(`${base}/api/glint/photos/${id}/preview?taken=${Date.UTC(2001, 0, 1)}&w=10&h=10`, {
    method: 'PUT', headers: { Cookie: mia, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 1, 2]),
  });
  assert.equal((await d.json()).item.taken, Date.UTC(2019, 6, 4, 12));
  // ...but a photo with no date from Google takes the browser's.
  const nodate = byName['nodate.png'];
  const d2 = await fetch(`${base}/api/glint/photos/${nodate.id}/preview?taken=${Date.UTC(2018, 0, 1)}`, {
    method: 'PUT', headers: { Cookie: mia, 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(0),
  });
  assert.equal((await d2.json()).item.taken, Date.UTC(2018, 0, 1));
});

test('running it again changes nothing, and a second export skips what is already here', async () => {
  await call('POST', '/api/glint/import/start', {}, mia);
  const s = await finished(mia);
  assert.equal(s.job.total, 0);
  assert.equal((await call('GET', '/api/glint/photos', null, mia)).body.total, 6);

  await putZip(mia, 'takeout-002.zip', makeZip([
    { name: `${G}Photos from 2019/IMG_1.jpg`, data: 'photo A bytes' },
    { name: `${G}Photos from 2019/IMG_1.jpg.json`, data: meta(2019, 7, 4) },
    { name: `${G}Photos from 2022/new.jpg`, data: 'brand new' },
    { name: `${G}Photos from 2022/new.jpg.json`, data: meta(2022, 2, 2) },
  ]));
  await call('POST', '/api/glint/import/start', { deleteZips: true }, mia);
  const t = await finished(mia);
  assert.equal((await call('GET', '/api/glint/photos', null, mia)).body.total, 7);
  assert.equal(t.zips.find((z) => z.name === 'takeout-002.zip'), undefined, 'a clean zip is deleted when asked');
  assert.ok(t.zips.find((z) => z.name === 'takeout-001.zip'), 'a zip with a problem is kept');
});

test('delete the zips frees their space; a full limit stops the move with a message', async () => {
  const del = await call('POST', '/api/glint/import/delete-zips', {}, mia);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.zips, []);
  assert.ok(!fs.existsSync(path.join(miaHome(), 'files', 'Move to Glint', 'takeout-001.zip')));

  await putZip(mia, 'takeout-003.zip', makeZip([{ name: `${G}Photos from 2023/big.jpg`, data: 'a photo that will not fit' }]));
  const before = (await call('GET', '/api/glint/photos', null, mia)).body.total;
  const real = server.glint.nest.checkSpace;
  server.glint.nest.checkSpace = () => { throw new HttpError(413, 'Not enough space: 0 GB left of your 1 GB'); };
  try {
    await call('POST', '/api/glint/import/start', {}, mia);
    const s = await finished(mia);
    assert.match(s.job.error, /Not enough space/);
  } finally {
    server.glint.nest.checkSpace = real;
  }
  assert.equal((await call('GET', '/api/glint/photos', null, mia)).body.total, before);
  // With room again it carries on and moves it.
  await call('POST', '/api/glint/import/start', {}, mia);
  await finished(mia);
  assert.equal((await call('GET', '/api/glint/photos', null, mia)).body.total, before + 1);
});
