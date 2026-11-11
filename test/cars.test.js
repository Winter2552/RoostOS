'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');
const { cleanPlate } = require('../src/cars');

let server;
let base;
let dataDir;
let admin;
let sam;
let mia;
let guest;
const ids = {};

// The smallest thing that passes for a JPEG: the right first bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-cars-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  for (const name of ['sam', 'mia']) {
    const made = await call('POST', '/api/admin/users', { username: name, password: 'password1', limitGb: 1, apps: ['cars'] }, admin);
    ids[name] = made.body.user.id;
  }
  // Raven gives Sam and Mia the Cars app; a third person without it.
  const nope = await call('POST', '/api/admin/users', { username: 'noel', password: 'password1', limitGb: 1, apps: ['nest'] }, admin);
  ids.noel = nope.body.user.id;
  sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  mia = (await call('POST', '/api/login', { username: 'mia', password: 'password1' })).cookie;
  guest = (await call('POST', '/api/login', { username: 'noel', password: 'password1' })).cookie;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('plates are tidied', () => {
  assert.equal(cleanPlate('  ab12   cde! '), 'AB12 CDE');
});

test('the Cars app is admin-only at first, and people without it are shut out', async () => {
  assert.equal((await call('GET', '/api/cars', null, guest)).body.cars.length, 0);
  assert.equal((await call('POST', '/api/cars', { name: 'Golf' }, guest)).status, 403);
  const made = await call('POST', '/api/cars', { name: 'Golf', plate: 'ab12 cde', year: 2016, fuel: 'diesel' }, sam);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.plate, 'AB12 CDE');
  assert.equal(made.body.role, 'owner');
  ids.golf = made.body.id;
});

test('a car is private to its owner: others, and admins, get "not there"', async () => {
  for (const who of [mia, admin, guest]) {
    assert.equal((await call('GET', `/api/cars/${ids.golf}`, null, who)).status, 404);
    assert.equal((await call('GET', `/api/cars/${ids.golf}/photo`, null, who)).status, 404);
    assert.equal((await call('PATCH', `/api/cars/${ids.golf}`, { name: 'x' }, who)).status, 404);
    assert.equal((await call('DELETE', `/api/cars/${ids.golf}`, { name: 'Golf' }, who)).status, 404);
  }
  assert.equal((await call('GET', '/api/cars', null, mia)).body.cars.length, 0);
  assert.equal((await call('GET', '/api/cars', null, admin)).body.cars.length, 0);
});

test('sharing: viewers can look but not change, only app holders can be added', async () => {
  const res = await call('PUT', `/api/cars/${ids.golf}/share`, { shares: [{ userId: ids.mia, role: 'viewer' }, { userId: ids.noel, role: 'editor' }, { userId: ids.sam, role: 'editor' }, { userId: 'ghost', role: 'viewer' }] }, sam);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.shares.map((s) => [s.userId, s.role]), [[ids.mia, 'viewer']], 'noel has no app, sam is the owner, ghost does not exist');
  const seen = await call('GET', `/api/cars/${ids.golf}`, null, mia);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.role, 'viewer');
  assert.equal(seen.body.shares, undefined, 'only the owner sees who it is shared with');
  assert.equal((await call('PATCH', `/api/cars/${ids.golf}`, { name: 'Mine now' }, mia)).status, 403);
  assert.equal((await call('PUT', `/api/cars/${ids.golf}/share`, { shares: [] }, mia)).status, 403);
  assert.equal((await call('GET', `/api/cars/${ids.golf}`, null, guest)).status, 404);
});

test('household shows a car to everyone with the app, and switching it off hides it', async () => {
  const on = await call('PUT', `/api/cars/${ids.golf}/share`, { shares: [], household: true }, sam);
  assert.equal(on.body.household, true);
  assert.equal((await call('GET', '/api/cars', null, mia)).body.cars.length, 1);
  assert.equal((await call('GET', '/api/cars', null, guest)).body.cars.length, 0, 'noel has no Cars app');
  await call('PUT', `/api/cars/${ids.golf}/share`, { shares: [], household: false }, sam);
  assert.equal((await call('GET', '/api/cars', null, mia)).body.cars.length, 0);
});

test('taking the app away from someone hides every car from them again', async () => {
  await call('PUT', `/api/cars/${ids.golf}/share`, { shares: [{ userId: ids.mia, role: 'editor' }] }, sam);
  assert.equal((await call('GET', `/api/cars/${ids.golf}`, null, mia)).status, 200);
  await call('PATCH', `/api/admin/users/${ids.mia}`, { apps: ['nest'] }, admin);
  assert.equal((await call('GET', `/api/cars/${ids.golf}`, null, mia)).status, 404);
  assert.equal((await call('GET', '/api/cars', null, mia)).body.people.length, 0);
  await call('PATCH', `/api/admin/users/${ids.mia}`, { apps: ['cars'] }, admin);
});

test('photos must be small JPEGs, and are only served to people who can see the car', async () => {
  const put = (body, type = 'image/jpeg', cookie = sam) => fetch(`${base}/api/cars/${ids.golf}/photo`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': type, Connection: 'close' }, body });
  assert.equal((await put(JPEG, 'image/png')).status, 415);
  assert.equal((await put(Buffer.from('<script>alert(1)</script>'.repeat(10)))).status, 400);
  // The server may hang up while the oversize photo is still arriving.
  const big = await put(Buffer.concat([JPEG, Buffer.alloc(800 * 1024)])).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.equal((await put(JPEG, 'image/jpeg', mia)).status, 403, 'a shared editor still can’t change the profile photo');
  const ok = await put(JPEG);
  assert.equal(ok.status, 200);
  const car = await ok.json();
  assert.match(car.photo, /^\/api\/cars\/.+\/photo\?v=\d+$/);
  const got = await fetch(base + car.photo, { headers: { Cookie: mia } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
  assert.equal((await fetch(base + car.photo, { headers: { Cookie: guest } })).status, 404);
  assert.equal((await fetch(base + car.photo)).status, 401);
});

test('archive keeps a car; deleting needs its name and removes the photo', async () => {
  const arch = await call('POST', `/api/cars/${ids.golf}/archive`, { on: true }, sam);
  assert.equal(arch.body.archived, true);
  const second = await call('POST', '/api/cars', { name: 'Fiesta' }, sam);
  const list = (await call('GET', '/api/cars', null, sam)).body.cars;
  assert.deepEqual(list.map((c) => c.name), ['Fiesta', 'Golf'], 'archived cars sort last');
  assert.equal((await call('DELETE', `/api/cars/${ids.golf}`, { name: 'wrong' }, sam)).status, 400);
  assert.equal((await call('DELETE', `/api/cars/${ids.golf}`, { name: 'golf' }, sam)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'cars', `${ids.golf}.jpg`)), false);
  assert.equal((await call('GET', `/api/cars/${ids.golf}`, null, sam)).status, 404);
  ids.fiesta = second.body.id;
});

test('deleting a person removes their cars and their shares', async () => {
  await call('PUT', `/api/cars/${ids.fiesta}/share`, { shares: [{ userId: ids.mia, role: 'viewer' }] }, sam);
  const miaCar = await call('POST', '/api/cars', { name: 'Mini' }, mia);
  assert.equal((await call('DELETE', `/api/admin/users/${ids.mia}`, null, admin)).status, 200);
  const fiesta = await call('GET', `/api/cars/${ids.fiesta}`, null, sam);
  assert.deepEqual(fiesta.body.shares, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8')).cars.some((c) => c.id === miaCar.body.id), false);
});

test('bad input is refused', async () => {
  assert.equal((await call('POST', '/api/cars', { name: '' }, sam)).status, 400);
  assert.equal((await call('POST', '/api/cars', { name: 'X', year: 1850 }, sam)).status, 400);
  assert.equal((await call('POST', '/api/cars', { name: 'X', fuel: 'steam' }, sam)).status, 400);
  assert.equal((await call('GET', '/api/cars')).status, 401);
});

test('dates over HTTP: add, change, snooze, renew, remove, and nobody else can touch them', async () => {
  const car = (await call('POST', '/api/cars', { name: 'Van' }, sam)).body;
  const added = await call('POST', `/api/cars/${car.id}/dates`, { kind: 'mot', due: '2030-05-01' }, sam);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const did = added.body.dates[0].id;
  assert.equal((await call('POST', `/api/cars/${car.id}/dates`, { kind: 'mot', due: 'soon' }, sam)).status, 400);
  assert.equal((await call('PATCH', `/api/cars/${car.id}/dates/${did}`, { due: '2030-06-01', label: 'MOT test' }, sam)).body.dates[0].label, 'MOT test');
  assert.equal((await call('POST', `/api/cars/${car.id}/dates/${did}/snooze`, null, sam)).status, 200);
  const renewed = await call('POST', `/api/cars/${car.id}/dates/${did}/done`, {}, sam);
  assert.equal(renewed.body.dates[0].due, '2031-06-01');
  for (const who of [admin, guest]) {
    assert.equal((await call('POST', `/api/cars/${car.id}/dates/${did}/done`, {}, who)).status, 404);
    assert.equal((await call('DELETE', `/api/cars/${car.id}/dates/${did}`, null, who)).status, 404);
  }
  assert.equal((await call('GET', `/api/cars/${car.id}`, null, sam)).body.next.label, 'MOT test');
  const gone = await call('DELETE', `/api/cars/${car.id}/dates/${did}`, null, sam);
  assert.deepEqual(gone.body.dates, []);
});
