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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-nestimport-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  const made = await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', limitGb: 1, apps: ['nest', 'glint'] }, admin);
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

// Zips go up the way the page sends them: a Nest upload into the "Move to Nest" folder.
async function putZip(cookie, name, buf) {
  const start = await call('POST', '/api/nest/uploads', { parent: 'root', path: 'Move to Nest', name, size: buf.length, type: 'application/zip' }, cookie);
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
const T = 'Takeout/Drive/';
const when = Date.UTC(2021, 3, 5, 10, 30, 0);

test('Move to Nest needs zips first', async () => {
  assert.equal((await call('POST', '/api/nest/import/start', {}, mia)).status, 400);
  assert.equal((await call('GET', '/api/nest/import')).status, 401);
});

test('a Takeout of Drive keeps the folders, dates and empty folders', async () => {
  await putZip(mia, 'takeout-001.zip', makeZip([
    { name: 'Takeout/archive_browser.html', data: '<html>' },
    { name: `${T}Work/Reports/Q1.docx`, data: 'q1 report', deflate: true, mtime: when },
    { name: `${T}Work/Reports/Q2.xlsx`, data: 'q2 sheet', mtime: when },
    { name: `${T}Work/Empty folder/`, data: '' },
    { name: `${T}Notes.txt`, data: 'my notes', mtime: when },
    { name: `${T}Work/.DS_Store`, data: 'junk' },
    { name: 'Takeout/Google Photos/Photos from 2020/a.jpg', data: 'not drive' },
    { name: `${T}Work/Reports/damaged.pdf`, data: 'will be damaged' },
  ]));
  const saved = path.join(miaFiles(), 'Move to Nest', 'takeout-001.zip');
  const buf = fs.readFileSync(saved);
  buf[buf.indexOf('will be damaged')] ^= 0xff;
  fs.writeFileSync(saved, buf);

  assert.equal((await call('POST', '/api/nest/import/start', {}, mia)).status, 200);
  const s = await finished(mia);
  assert.equal(s.job.error, '');
  assert.equal(s.counts.moved, 3);
  assert.equal(s.counts.problem, 1);
  assert.match(s.problems[0].note, /damaged/);

  const root = path.join(miaFiles(), 'From Google Drive');
  assert.equal(fs.readFileSync(path.join(root, 'Notes.txt'), 'utf8'), 'my notes');
  assert.equal(fs.readFileSync(path.join(root, 'Work', 'Reports', 'Q1.docx'), 'utf8'), 'q1 report');
  assert.ok(fs.statSync(path.join(root, 'Work', 'Empty folder')).isDirectory());
  assert.ok(!fs.existsSync(path.join(root, 'Work', '.DS_Store')));
  assert.ok(!fs.existsSync(path.join(root, 'Photos from 2020')));
  assert.ok(Math.abs(fs.statSync(path.join(root, 'Notes.txt')).mtimeMs - when) < 3000);

  // They show up in Nest like any other files, with the date.
  const top = (await call('GET', '/api/nest/folders/root', null, mia)).body.items;
  const folder = top.find((i) => i.name === 'From Google Drive');
  const inside = (await call('GET', `/api/nest/folders/${folder.id}`, null, mia)).body.items;
  const notes = inside.find((i) => i.name === 'Notes.txt');
  assert.ok(Math.abs(notes.modified - when) < 3000);
});

test('files shared with you come in from Drive\'s own zips, and repeats are skipped', async () => {
  await putZip(mia, 'drive-download-1.zip', makeZip([
    { name: 'Team plan/Plan.pdf', data: 'the plan', mtime: when },
    { name: 'Team plan/Budget/2021.xlsx', data: 'budget', mtime: when },
    { name: 'loose.txt', data: 'one loose file' },
  ]));
  await call('POST', '/api/nest/import/start', {}, mia);
  const s = await finished(mia);
  const shared = path.join(miaFiles(), 'From Google Drive', 'Shared with me');
  assert.equal(fs.readFileSync(path.join(shared, 'Team plan', 'Plan.pdf'), 'utf8'), 'the plan');
  assert.equal(fs.readFileSync(path.join(shared, 'Team plan', 'Budget', '2021.xlsx'), 'utf8'), 'budget');
  assert.equal(fs.readFileSync(path.join(shared, 'loose.txt'), 'utf8'), 'one loose file');
  assert.equal(s.counts.moved, 6);

  // The same files again: nothing new. A changed file keeps both.
  await putZip(mia, 'drive-download-2.zip', makeZip([
    { name: 'Team plan/Plan.pdf', data: 'the plan' },
    { name: 'loose.txt', data: 'one loose file, now longer' },
  ]));
  await call('POST', '/api/nest/import/start', { deleteZips: true }, mia);
  const t = await finished(mia);
  assert.equal(t.counts.dup, 1);
  assert.equal(fs.readFileSync(path.join(shared, 'loose (1).txt'), 'utf8'), 'one loose file, now longer');
  assert.equal(t.zips.find((z) => z.name === 'drive-download-2.zip'), undefined, 'a clean zip is deleted when asked');
  assert.ok(t.zips.find((z) => z.name === 'takeout-001.zip'), 'a zip with a problem is kept');
});

test('a full limit stops it with a message, delete the zips frees space, Move to Glint is separate', async () => {
  await putZip(mia, 'drive-download-3.zip', makeZip([{ name: 'big/file.bin', data: 'will not fit' }]));
  const real = server.glint.nest.checkSpace;
  server.glint.nest.checkSpace = () => { throw new HttpError(413, 'Not enough space: 0 GB left of your 1 GB'); };
  try {
    await call('POST', '/api/nest/import/start', {}, mia);
    assert.match((await finished(mia)).job.error, /Not enough space/);
  } finally {
    server.glint.nest.checkSpace = real;
  }
  assert.ok(!fs.existsSync(path.join(miaFiles(), 'From Google Drive', 'Shared with me', 'big', 'file.bin')));
  await call('POST', '/api/nest/import/start', {}, mia);
  await finished(mia);
  assert.ok(fs.existsSync(path.join(miaFiles(), 'From Google Drive', 'Shared with me', 'big', 'file.bin')));

  const del = await call('POST', '/api/nest/import/delete-zips', {}, mia);
  assert.deepEqual(del.body.zips, []);
  assert.ok(!fs.existsSync(path.join(miaFiles(), 'Move to Nest', 'takeout-001.zip')));
  // Glint's own move sees none of these.
  const g = await call('GET', '/api/glint/import', null, admin);
  assert.deepEqual(g.body.counts, { moved: 0, nodate: 0, dup: 0, skipped: 0, problem: 0 });
});

test('photos moved in from Drive sit in Glint on their original date, not the day they arrived', async () => {
  const old = Date.UTC(2006, 7, 1, 9, 46, 0);
  await putZip(mia, 'takeout-photos.zip', makeZip([
    { name: `${T}Kids/Photos/P1010003.jpg`, data: 'an old photo with no exif', mtime: old },
  ]));
  await call('POST', '/api/nest/import/start', {}, mia);
  await finished(mia);
  const page = (await call('GET', '/api/glint/photos', null, mia)).body;
  const p = page.items.find((i) => i.name === 'P1010003.jpg');
  assert.ok(Math.abs(p.taken - old) < 3000, new Date(p.taken).toISOString());

  // Photos already in Glint with the arrival date get fixed too, once, and a real date is left alone.
  const db = server.glint.db;
  db.prepare('UPDATE photos SET taken = (SELECT created FROM nodes WHERE id = photos.id) WHERE id = ?').run(p.id);
  assert.equal(server.glint.repairDates(), 1);
  assert.ok(Math.abs((await call('GET', '/api/glint/photos', null, mia)).body.items.find((i) => i.id === p.id).taken - old) < 3000);
  db.prepare('UPDATE photos SET taken = ? WHERE id = ?').run(Date.UTC(2006, 7, 2), p.id);
  assert.equal(server.glint.repairDates(), 0);
});
