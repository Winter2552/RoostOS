'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createServer } = require('../src/server');
const convert = require('../src/convert');
const { setUpTwoStep } = require('./helpers');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

let server;
let base;
let dataDir;
let admin;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-convert-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
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

async function upload(name, buf) {
  const start = await call('POST', '/api/nest/uploads', { parent: 'root', name, size: buf.length }, admin);
  assert.equal(start.status, 201);
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, {
    method: 'PUT', headers: { Cookie: admin, 'Content-Type': 'application/octet-stream' }, body: buf,
  });
  return (await res.json()).item;
}

function make(file, args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, file]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(file);
}

test('format names are sorted into photos and videos', () => {
  assert.equal(convert.convertKind('IMG_1.HEIC'), 'image');
  assert.equal(convert.convertKind('a.tiff'), 'image');
  assert.equal(convert.convertKind('clip.3gp'), 'video');
  assert.equal(convert.convertKind('film.mkv'), 'video');
  assert.equal(convert.convertKind('photo.jpg'), '');
  assert.equal(convert.convertKind('notes.txt'), '');
});

test('a converted copy of an MKV is an MP4, and the original stays', { skip: !haveFfmpeg }, async () => {
  const mkv = make(path.join(dataDir, 'in.mkv'), ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'mpeg4']);
  const item = await upload('clip.mkv', mkv);
  // Shown as it is first (the browser may play MKV itself)...
  const plain = await fetch(`${base}/api/nest/files/${item.id}?view=1`, { headers: { Cookie: admin } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'video/x-matroska');
  // ...then as an MP4 copy when it can't.
  const res = await fetch(`${base}/api/nest/files/${item.id}?view=1&preview=1`, { headers: { Cookie: admin } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const out = Buffer.from(await res.arrayBuffer());
  assert.equal(out.subarray(4, 8).toString(), 'ftyp');
  const again = await fetch(`${base}/api/nest/files/${item.id}?view=1`, { headers: { Cookie: admin } });
  assert.equal(Buffer.from(await again.arrayBuffer()).length, mkv.length);
});

test('a TIFF photo gets a JPEG copy', { skip: !haveFfmpeg }, async () => {
  const tif = make(path.join(dataDir, 'in.tiff'), ['-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1']);
  const item = await upload('scan.tiff', tif);
  const res = await fetch(`${base}/api/nest/files/${item.id}?view=1&preview=1`, { headers: { Cookie: admin } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const out = Buffer.from(await res.arrayBuffer());
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
});

test('a file that cannot be converted says so, and other files are not converted', async () => {
  const bad = await upload('broken.heic', Buffer.from('not a photo'));
  const res = await fetch(`${base}/api/nest/files/${bad.id}?view=1&preview=1`, { headers: { Cookie: admin } });
  assert.equal(res.status, 422);
  const txt = await upload('a.txt', Buffer.from('hi'));
  const no = await fetch(`${base}/api/nest/files/${txt.id}?view=1&preview=1`, { headers: { Cookie: admin } });
  assert.equal(no.status, 404);
});
