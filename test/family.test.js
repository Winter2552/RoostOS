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
let sam;
let mia;
const ids = {};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-family-test-'));
  nestDir = path.join(dataDir, 'files');
  server = createServer({ dataDir, nestDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  for (const name of ['sam', 'mia']) {
    const made = await call('POST', '/api/admin/users', { username: name, password: 'password1', limitGb: 1 }, admin);
    ids[name] = made.body.user.id;
  }
  sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
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

async function upload(cookie, name, data, space = 'family') {
  const buf = Buffer.from(data);
  const q = space ? `?space=${space}` : '';
  const start = await call('POST', `/api/nest/uploads${q}`, { parent: 'root', name, size: buf.length }, cookie);
  if (start.status !== 201 || start.body.done) return start;
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0${space ? `&space=${space}` : ''}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

test('nobody is in the family at first, and outsiders are kept out', async () => {
  const fam = await call('GET', '/api/admin/family', null, admin);
  assert.deepEqual(fam.body.family, { members: [], limitGb: 100, usedBytes: 0 });
  assert.equal((await call('GET', '/api/state', null, sam)).body.user.family, false);
  assert.equal((await call('GET', '/api/nest/folders/root?space=family', null, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/family', null, sam)).status, 403);
});

test('members share one Family space, separate from their own drives', async () => {
  const put = await call('PUT', '/api/admin/family', { members: [ids.sam, ids.mia, 'nobody', ids.sam], limitGb: 2 }, admin);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.family.members, [ids.sam, ids.mia]);
  assert.equal((await call('GET', '/api/state', null, sam)).body.user.family, true);

  const up = await upload(sam, 'holiday.txt', 'sun and sea');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  // Mia sees Sam's file in Family, and can rename it.
  const list = await call('GET', '/api/nest/folders/root?space=family', null, mia);
  assert.deepEqual(list.body.items.map((i) => i.name), ['holiday.txt']);
  const renamed = await call('PATCH', `/api/nest/items/${list.body.items[0].id}?space=family`, { name: 'beach.txt' }, mia);
  assert.equal(renamed.status, 200);
  // It's not in anyone's own drive, and it's a real file on disk.
  assert.equal((await call('GET', '/api/nest/folders/root', null, sam)).body.items.length, 0);
  assert.equal(fs.readFileSync(path.join(nestDir, 'Family_family', 'files', 'beach.txt'), 'utf8'), 'sun and sea');
  // The family item can't be reached as Sam's own.
  assert.equal((await call('GET', `/api/nest/files/${list.body.items[0].id}`, null, sam)).status, 404);
});

test('family files count against the family limit, not the uploader', async () => {
  const me = await call('GET', '/api/me/storage', null, sam);
  assert.equal(me.body.storage.usedBytes, 0);
  const fam = await call('GET', '/api/admin/family', null, admin);
  assert.equal(fam.body.family.usedBytes, 'sun and sea'.length);
  // Over the family's 2 GB: refused, though Sam's own 1 GB is untouched.
  const big = await call('POST', '/api/nest/uploads?space=family', { parent: 'root', name: 'big.bin', size: 3 * 1024 ** 3 }, sam);
  assert.equal(big.status, 413);
  const list = await call('GET', '/api/nest/folders/root?space=family', null, mia);
  assert.equal(list.body.storage.limitBytes, 2 * 1024 ** 3);
});

test('leaving the family, or being removed, closes the space', async () => {
  await call('PUT', '/api/admin/family', { members: [ids.sam, ids.mia] }, admin);
  await call('DELETE', `/api/admin/users/${ids.mia}`, null, admin);
  assert.deepEqual((await call('GET', '/api/admin/family', null, admin)).body.family.members, [ids.sam]);
  await call('PUT', '/api/admin/family', { members: [] }, admin);
  assert.equal((await call('GET', '/api/nest/folders/root?space=family', null, sam)).status, 403);
  // The files stay for whoever joins next.
  await call('PUT', '/api/admin/family', { members: [ids.sam] }, admin);
  assert.equal((await call('GET', '/api/nest/folders/root?space=family', null, sam)).body.items.length, 1);
  const log = await call('GET', '/api/admin/activity?filter=users', null, admin);
  assert.ok(log.body.entries.some((e) => e.type === 'family-changed' && /added sam/.test(e.detail)));
});

test('a bad family limit is refused', async () => {
  assert.equal((await call('PUT', '/api/admin/family', { limitGb: 0 }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/family', { members: 'sam' }, admin)).status, 400);
});
