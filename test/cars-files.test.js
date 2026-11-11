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
let admin;
let sam;
let mia;
let noel;
const ids = {};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const PDF = Buffer.from(`%PDF-1.4\n${'x'.repeat(200)}\n%%EOF`);

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}
const send = (url, buf, cookie, method = 'POST') => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', Connection: 'close' }, body: buf }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-carfiles-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  for (const name of ['sam', 'mia', 'noel']) {
    const made = await call('POST', '/api/admin/users', { username: name, password: 'password1', limitGb: 1, apps: name === 'noel' ? ['nest'] : ['cars', 'nest'] }, admin);
    ids[name] = made.body.user.id;
  }
  sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  mia = (await call('POST', '/api/login', { username: 'mia', password: 'password1' })).cookie;
  noel = (await call('POST', '/api/login', { username: 'noel', password: 'password1' })).cookie;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const nestNames = async (cookie, dir) => {
  let parent = 'root';
  for (const part of dir.split('/')) {
    const list = await call('GET', `/api/nest/folders/${parent}`, null, cookie);
    const hit = (list.body.items || []).find((i) => i.name === part);
    if (!hit) return null;
    parent = hit.id;
  }
  return (await call('GET', `/api/nest/folders/${parent}`, null, cookie)).body.items.map((i) => i.name);
};

test('history fields: a garage, what was done, and an MOT result with advisories', async () => {
  const car = (await call('POST', '/api/cars', { name: 'Golf' }, sam)).body;
  ids.car = car.id;
  const mot = await call('POST', `/api/cars/${car.id}/entries`, { type: 'mot', date: '2026-10-01', amount: '54.85', odometer: 40000, garage: 'Main St Motors', result: 'pass', advisories: 'Front tyre close to the limit', note: 'Also wiper blades' }, sam);
  assert.equal(mot.status, 201, JSON.stringify(mot.body));
  assert.equal(mot.body.entry.result, 'pass');
  assert.equal(mot.body.entry.garage, 'Main St Motors');
  assert.equal(mot.body.entry.advisories, 'Front tyre close to the limit');
  const fuel = await call('POST', `/api/cars/${car.id}/entries`, { type: 'fuel', date: '2026-10-02', amount: '50', litres: 30, garage: 'Shell', result: 'pass', advisories: 'ignored' }, sam);
  assert.equal(fuel.body.entry.result, '', 'MOT fields only count on an MOT');
  ids.mot = mot.body.entry.id;
  ids.fuel = fuel.body.entry.id;
});

test('a receipt goes into the owner’s Nest under Cars/<car>/Receipts, and the car shows it', async () => {
  const up = await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=${encodeURIComponent('MOT slip')}`, JPEG, sam);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const file = up.body.files[0];
  assert.equal(file.kind, 'receipt');
  assert.equal(file.entryId, ids.mot);
  assert.equal(up.body.entries.find((e) => e.id === ids.mot).receipts, 1);
  const names = await nestNames(sam, 'Cars/Golf/Receipts');
  assert.ok(names && names.length === 1 && /MOT slip\.jpg$/.test(names[0]), JSON.stringify(names));
  const got = await fetch(`${base}/api/cars/${ids.car}/files/${file.id}`, { headers: { Cookie: sam } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
  ids.file = file.id;
});

test('only photos and PDFs, judged by their first bytes, and not too big', async () => {
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=x.jpg`, Buffer.from('<html><script>alert(1)</script></html>'), sam)).status, 415);
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=x`, Buffer.alloc(0), sam)).status, 400);
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=receipt&entry=nope&name=x`, JPEG, sam)).status, 404);
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=other&name=x`, JPEG, sam)).status, 400);
  const big = await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=x`, Buffer.concat([JPEG, Buffer.alloc(13 * 1024 * 1024)]), sam).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('sharing: viewers can open receipts through the car, others can’t, nobody gets in through the car’s files', async () => {
  const paper = await send(`/api/cars/${ids.car}/files?kind=paper&name=${encodeURIComponent('V5C')}`, PDF, sam);
  assert.equal(paper.status, 201);
  ids.paper = paper.body.files.find((f) => f.kind === 'paper').id;
  assert.equal((await nestNames(sam, 'Cars/Golf/Papers'))[0], 'V5C.pdf');
  await call('PUT', `/api/cars/${ids.car}/share`, { shares: [{ userId: ids.mia, role: 'viewer' }] }, sam);
  for (const fid of [ids.file, ids.paper]) {
    assert.equal((await fetch(`${base}/api/cars/${ids.car}/files/${fid}`, { headers: { Cookie: mia } })).status, 200, 'a viewer can open it');
    for (const who of [admin, noel]) assert.equal((await fetch(`${base}/api/cars/${ids.car}/files/${fid}`, { headers: { Cookie: who } })).status, 404);
  }
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=x`, JPEG, mia)).status, 403, 'a viewer can’t add');
  assert.equal((await call('DELETE', `/api/cars/${ids.car}/files/${ids.file}`, null, mia)).status, 403);
  assert.equal((await nestNames(mia, 'Cars')), null, 'nothing shows up in a viewer’s own Nest');
});

test('editors add receipts to their own entries only; papers stay with the owner', async () => {
  await call('PUT', `/api/cars/${ids.car}/share`, { shares: [{ userId: ids.mia, role: 'editor' }] }, sam);
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${ids.mot}&name=x`, JPEG, mia)).status, 403, 'not Sam’s entry');
  const hers = (await call('POST', `/api/cars/${ids.car}/entries`, { type: 'parking', amount: '3' }, mia)).body.entry;
  const ok = await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${hers.id}&name=ticket`, JPEG, mia);
  assert.equal(ok.status, 201);
  assert.equal((await send(`/api/cars/${ids.car}/files?kind=paper&name=x`, PDF, mia)).status, 403);
  const mine = ok.body.files.find((f) => f.entryId === hers.id);
  assert.equal((await call('DELETE', `/api/cars/${ids.car}/files/${mine.id}`, null, mia)).status, 200);
  assert.equal((await call('DELETE', `/api/cars/${ids.car}/files/${ids.paper}`, null, mia)).status, 403);
  ids.hers = hers.id;
});

test('deleting an entry or a car sends its files to the Nest trash', async () => {
  const entry = (await call('POST', `/api/cars/${ids.car}/entries`, { type: 'wash', amount: '5' }, sam)).body.entry;
  await send(`/api/cars/${ids.car}/files?kind=receipt&entry=${entry.id}&name=wash`, JPEG, sam);
  assert.equal((await nestNames(sam, 'Cars/Golf/Receipts')).length, 2);
  await call('DELETE', `/api/cars/${ids.car}/entries/${entry.id}`, null, sam);
  assert.equal((await nestNames(sam, 'Cars/Golf/Receipts')).length, 1, 'its receipt is in the trash now');
  const trash = await call('GET', '/api/nest/trash', null, sam);
  assert.ok((trash.body.items || []).some((i) => /wash\.jpg$/.test(i.name)), JSON.stringify(trash.body).slice(0, 200));
  assert.equal((await call('DELETE', `/api/cars/${ids.car}`, { name: 'Golf' }, sam)).status, 200);
  assert.deepEqual(await nestNames(sam, 'Cars/Golf/Receipts'), [], 'every receipt is trashed with the car');
  assert.deepEqual(await nestNames(sam, 'Cars/Golf/Papers'), []);
});

test('two cars with the same name keep separate folders', async () => {
  const a = (await call('POST', '/api/cars', { name: 'Fiesta' }, sam)).body;
  const b = (await call('POST', '/api/cars', { name: 'Fiesta' }, sam)).body;
  const ea = (await call('POST', `/api/cars/${a.id}/entries`, { type: 'wash', amount: '1' }, sam)).body.entry;
  const eb = (await call('POST', `/api/cars/${b.id}/entries`, { type: 'wash', amount: '1' }, sam)).body.entry;
  await send(`/api/cars/${a.id}/files?kind=receipt&entry=${ea.id}&name=r`, JPEG, sam);
  await send(`/api/cars/${b.id}/files?kind=receipt&entry=${eb.id}&name=r`, JPEG, sam);
  const top = (await call('GET', '/api/nest/folders/root', null, sam)).body.items.find((i) => i.name === 'Cars');
  const inside = (await call('GET', `/api/nest/folders/${top.id}`, null, sam)).body.items.map((i) => i.name).filter((n) => n.startsWith('Fiesta'));
  assert.equal(inside.length, 2);
});
