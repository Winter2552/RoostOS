'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { HttpError } = require('../src/http');
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-fileinfo-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  const made = await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', limitGb: 1, apps: ['nest'] }, admin);
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

// Files go up the way the page sends them: a Nest upload.
async function putFile(cookie, dir, name, buf) {
  const start = await call('POST', '/api/nest/uploads', { parent: 'root', path: dir, name, size: buf.length, type: 'application/octet-stream' }, cookie);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: buf,
  });
  assert.equal(res.status, 200);
}

async function finished(cookie) {
  for (let i = 0; i < 200; i++) {
    const s = (await call('GET', '/api/nest/import', null, cookie)).body;
    if (s.job && !s.job.running) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the move never finished');
}

const miaFiles = () => path.join(nestDir, `mia_${miaId}`, 'files');
const putZip = (cookie, name, buf) => putFile(cookie, 'Move to Nest', name, buf);

const T = 'Takeout/Drive/';
const driveInfo = (title, size, extra = {}) => JSON.stringify({
  starred: true,
  content_last_modified: '2022-12-25T23:57:34Z',
  created: '2022-12-26T00:00:45.585Z',
  permissions: [
    { name: 'Raven Monz', type: 'user', role: 'owner', email_address: 'raven.monz@gmail.com', photo_link: 'https://lh3.googleusercontent.com/x' },
    { name: 'Sam', type: 'user', role: 'writer', email_address: 'sam@example.com' },
  ],
  title, drive_id: `id-${title}`, mime_type: 'video/mp4', expected_item_size: size,
  download_url: `https://drive.google.com/file/d/id-${title}/view`, ...extra,
});

async function listing(cookie, ...names) {
  let id = 'root';
  for (const n of names) {
    const items = (await call('GET', `/api/nest/folders/${id}`, null, cookie)).body.items;
    id = items.find((i) => i.name === n).id;
  }
  return (await call('GET', `/api/nest/folders/${id}`, null, cookie)).body.items;
}

const info = async (cookie, id) => (await call('GET', `/api/nest/items/${id}/info`, null, cookie));

test('info files are merged into their file and not shown; other JSON stays', async () => {
  await putZip(mia, 'takeout-1.zip', makeZip([
    { name: `${T}Films/Teaser.mp4`, data: 'film bytes' },
    { name: `${T}Films/Teaser.mp4-info.json`, data: driveInfo('Teaser.mp4', 10) },
    { name: `${T}Films/Loose.mp4`, data: 'sidecar lives elsewhere' },
    { name: `${T}Info/Loose.mp4-info.json`, data: driveInfo('Loose.mp4', 23) },
    { name: `${T}Films/settings.json`, data: '{"theme":"dark"}' },
    { name: `${T}Films/settings`, data: 'a file beside settings.json' },
    { name: `${T}Films/Lonely-info.json`, data: driveInfo('Lonely', 5) },
    { name: `${T}Films/broken.mp4`, data: 'x' },
    { name: `${T}Films/broken.mp4-info.json`, data: '{not json' },
  ]));
  await call('POST', '/api/nest/import/start', {}, mia);
  const s = await finished(mia);
  assert.equal(s.job.error, '');

  const films = (await listing(mia, 'From Google Drive', 'Films')).map((i) => i.name).sort();
  assert.deepEqual(films, ['Lonely-info.json', 'Loose.mp4', 'Teaser.mp4', 'broken.mp4', 'broken.mp4-info.json', 'settings', 'settings.json']);
  const top = (await listing(mia, 'From Google Drive')).map((i) => i.name);
  assert.ok(!top.includes('Info'), 'a claimed sidecar leaves no file behind');

  const teaser = (await listing(mia, 'From Google Drive', 'Films')).find((i) => i.name === 'Teaser.mp4');
  const t = (await info(mia, teaser.id)).body.info;
  assert.equal(t.name, 'Teaser.mp4');
  assert.deepEqual(t.where, ['My Drive', 'From Google Drive', 'Films']);
  assert.equal(t.google.source, 'drive');
  assert.equal(t.google.owner.email, 'raven.monz@gmail.com');
  assert.equal(t.google.shared[0].name, 'Sam');
  assert.equal(t.google.shared[0].role, 'writer');
  assert.equal(t.google.driveId, 'id-Teaser.mp4');
  assert.equal(t.google.starred, true);
  assert.equal(JSON.stringify(t.google).includes('lh3.googleusercontent'), false, 'avatar links are not kept');

  const loose = (await listing(mia, 'From Google Drive', 'Films')).find((i) => i.name === 'Loose.mp4');
  assert.equal((await info(mia, loose.id)).body.info.google.driveId, 'id-Loose.mp4', 'matched by title and size');
  const settings = (await listing(mia, 'From Google Drive', 'Films')).find((i) => i.name === 'settings');
  assert.equal((await info(mia, settings.id)).body.info.google, null, 'a JSON that is not a Google file is never merged');
});

test('Info is private, copies keep it and deleting forgets it', async () => {
  const films = await listing(mia, 'From Google Drive', 'Films');
  const teaser = films.find((i) => i.name === 'Teaser.mp4');
  assert.equal((await info(admin, teaser.id)).status, 404);
  assert.equal((await info(null, teaser.id)).status, 401);

  const copy = (await call('POST', '/api/nest/copy', { ids: [teaser.id] }, mia)).body.items[0];
  assert.equal((await info(mia, copy.id)).body.info.google.driveId, 'id-Teaser.mp4');

  await call('POST', '/api/nest/trash', { ids: [copy.id] }, mia);
  await call('POST', '/api/nest/trash/delete', { ids: [copy.id] }, mia);
  const left = server.nest.db.prepare('SELECT COUNT(*) AS n FROM node_info WHERE id = ?').get(copy.id).n;
  assert.equal(left, 0);
});

test('Photos info files keep the date, place and description', async () => {
  const { parseSidecar } = require('../src/file-info');
  const p = parseSidecar({
    title: 'IMG_1.jpg', description: 'On the beach', photoTakenTime: { timestamp: '1600000000' }, creationTime: { timestamp: '1600000100' },
    geoData: { latitude: 51.5, longitude: -0.12 }, people: [{ name: 'Sam' }], favorited: true, url: 'https://photos.google.com/photo/abc',
  });
  assert.equal(p.source, 'photos');
  assert.equal(p.taken, 1600000000000);
  assert.equal(p.lat, 51.5);
  assert.deepEqual(p.people, ['Sam']);
  assert.equal(parseSidecar({ title: 'x', photoTakenTime: { timestamp: '1' }, geoData: { latitude: 0, longitude: 0 } }).lat, undefined, '0,0 is "no place"');
  assert.equal(parseSidecar({ theme: 'dark' }), null);
  assert.equal(parseSidecar([1, 2]), null);
});

test('tidy up merges old info files and leaves every other JSON alone', async () => {
  const dir = 'From Google Drive/Old';
  await putFile(mia, dir, 'Song.mp3', Buffer.from('song'));
  await putFile(mia, dir, 'Song.mp3-info.json', Buffer.from(driveInfo('Song.mp3', 4)));
  await putFile(mia, dir, 'config.json', Buffer.from('{"a":1}'));
  await putFile(mia, dir, 'Ghost.mp3-info.json', Buffer.from(driveInfo('Ghost.mp3', 9)));
  await putFile(mia, dir, 'fake-info.json', Buffer.from('{"nope":true}'));
  await putFile(mia, dir, 'fake', Buffer.from('a main file with a non-Google JSON'));

  const look = (await call('POST', '/api/nest/import/tidy', { apply: false }, mia)).body.tidy;
  assert.equal(look.found, 1);
  assert.equal(look.left, 6, 'three left by the import test (settings, Lonely, broken) and config, Ghost, fake-info here');
  assert.equal((await listing(mia, 'From Google Drive', 'Old')).length, 6, 'checking changes nothing');

  const done = (await call('POST', '/api/nest/import/tidy', { apply: true }, mia)).body.tidy;
  assert.equal(done.tidied, 1);
  const names = (await listing(mia, 'From Google Drive', 'Old')).map((i) => i.name).sort();
  assert.deepEqual(names, ['Ghost.mp3-info.json', 'Song.mp3', 'config.json', 'fake', 'fake-info.json']);
  const song = (await listing(mia, 'From Google Drive', 'Old')).find((i) => i.name === 'Song.mp3');
  assert.equal((await info(mia, song.id)).body.info.google.driveId, 'id-Song.mp3');
  const trash = (await call('GET', '/api/nest/trash', null, mia)).body;
  assert.ok(JSON.stringify(trash).includes('Song.mp3-info.json'), 'the JSON is in the trash, not gone');
  assert.equal((await call('POST', '/api/nest/import/tidy', { apply: true }, mia)).body.tidy.tidied, 0, 'a second run finds nothing new');
});

test('the viewer serves pictures, PDFs and text in the page, and nothing else', async () => {
  const dir = 'Docs';
  await putFile(mia, dir, 'a.txt', Buffer.from('hello <b>there</b>'));
  await putFile(mia, dir, 'b.pdf', Buffer.from('%PDF-1.4'));
  await putFile(mia, dir, 'c.exe', Buffer.from('MZ'));
  const files = await listing(mia, 'Docs');
  const get = (n) => fetch(`${base}/api/nest/files/${files.find((f) => f.name === n).id}?view=1`, { headers: { Cookie: mia } });

  const txt = await get('a.txt');
  assert.equal(txt.status, 200);
  assert.match(txt.headers.get('content-type'), /^text\/plain/);
  assert.match(txt.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await txt.text(), 'hello <b>there</b>');

  const pdf = await get('b.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await get('c.exe')).status, 404);
  const plain = await fetch(`${base}/api/nest/files/${files.find((f) => f.name === 'a.txt').id}`, { headers: { Cookie: mia } });
  assert.equal(plain.headers.get('content-type'), 'application/octet-stream', 'a normal download is unchanged');
});

test('Google Docs, Sheets and Slides and folders have info files without the extension', async () => {
  const gdoc = (title, mime) => driveInfo(title, 0, { mime_type: mime });
  await putZip(mia, 'takeout-2.zip', makeZip([
    { name: `${T}Work/Budget.xlsx`, data: 'sheet' },
    { name: `${T}Work/Budget-info.json`, data: gdoc('Budget', 'application/vnd.google-apps.spreadsheet') },
    { name: `${T}Work/Plan.docx`, data: 'doc' },
    { name: `${T}Work/Plan-info.json`, data: gdoc('Plan', 'application/vnd.google-apps.document') },
    { name: `${T}Work/Both.docx`, data: 'doc2' },
    { name: `${T}Work/Both.xlsx`, data: 'sheet2' },
    { name: `${T}Work/Both-info.json`, data: gdoc('Both', 'application/vnd.google-apps.spreadsheet') },
    { name: `${T}Work/Assets/logo.txt`, data: 'logo' },
    { name: `${T}Work/Assets-info.json`, data: gdoc('Assets', 'application/vnd.google-apps.folder') },
    { name: `${T}Work/Ann's Flowers/list.txt`, data: 'roses' },
    { name: `${T}Work/Ann_s Flowers-info.json`, data: gdoc("Ann's Flowers", 'application/vnd.google-apps.folder') },
    { name: `${T}Work/Plain-info.json`, data: driveInfo('Plain', 1) },
  ]));
  await call('POST', '/api/nest/import/start', {}, mia);
  await finished(mia);
  const work = await listing(mia, 'From Google Drive', 'Work');
  assert.deepEqual(work.map((i) => i.name).sort(), ['Ann\'s Flowers', 'Assets', 'Both.docx', 'Both.xlsx', 'Budget.xlsx', 'Plain-info.json', 'Plan.docx']);
  const by = (n) => work.find((i) => i.name === n);
  assert.equal((await info(mia, by('Budget.xlsx').id)).body.info.google.driveId, 'id-Budget');
  assert.equal((await info(mia, by('Plan.docx').id)).body.info.google.driveId, 'id-Plan');
  assert.equal((await info(mia, by('Both.xlsx').id)).body.info.google.driveId, 'id-Both', 'Drive\'s own type picks the spreadsheet');
  assert.equal((await info(mia, by('Both.docx').id)).body.info.google, null);
  assert.equal((await info(mia, by('Assets').id)).body.info.google.driveId, 'id-Assets', 'a folder keeps its own info');
  assert.equal((await info(mia, by('Ann\'s Flowers').id)).body.info.google.driveId, 'id-Ann\'s Flowers', 'matched by Drive title when the file name differs');
});

test('tidy up also handles Docs, Sheets, Slides and folders', async () => {
  const dir = 'From Google Drive/Older';
  await putFile(mia, dir, 'Deck.pptx', Buffer.from('deck'));
  await putFile(mia, dir, 'Deck-info.json', Buffer.from(driveInfo('Deck', 0, { mime_type: 'application/vnd.google-apps.presentation' })));
  await putFile(mia, `${dir}/Photos`, 'a.txt', Buffer.from('a'));
  await putFile(mia, dir, 'Photos-info.json', Buffer.from(driveInfo('Photos', 0, { mime_type: 'application/vnd.google-apps.folder' })));
  await putFile(mia, dir, 'Orphan-info.json', Buffer.from(driveInfo('Orphan', 0)));
  const done = (await call('POST', '/api/nest/import/tidy', { apply: true }, mia)).body.tidy;
  assert.equal(done.tidied, 2);
  const names = (await listing(mia, 'From Google Drive', 'Older')).map((i) => i.name).sort();
  assert.deepEqual(names, ['Deck.pptx', 'Orphan-info.json', 'Photos']);
  const older = await listing(mia, 'From Google Drive', 'Older');
  assert.equal((await info(mia, older.find((i) => i.name === 'Deck.pptx').id)).body.info.google.driveId, 'id-Deck');
  assert.equal((await info(mia, older.find((i) => i.name === 'Photos').id)).body.info.google.driveId, 'id-Photos');
});
