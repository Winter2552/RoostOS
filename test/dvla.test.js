'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');
const dvla = require('../src/dvla');

const REPLY = { registrationNumber: 'AB12CDE', make: 'VOLKSWAGEN', colour: 'BLACK', yearOfManufacture: 2016, fuelType: 'DIESEL', taxStatus: 'Taxed', taxDueDate: '2027-08-01', motStatus: 'Valid', motExpiryDate: '2026-11-30', engineCapacity: 1968, dateOfLastV5CIssued: '2020-01-02' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('plates are tidied for the DVLA, and the answer is cut down to what Roost uses', () => {
  assert.equal(dvla.cleanPlate(' ab12 cde '), 'AB12CDE');
  assert.equal(dvla.cleanPlate(''), null);
  assert.equal(dvla.cleanPlate('A'), null);
  assert.equal(dvla.cleanPlate('ABCDEFGHI'), null);
  const v = dvla.readVehicle(REPLY);
  assert.deepEqual(v, { make: 'Volkswagen', colour: 'Black', year: 2016, fuel: 'diesel', tax: { status: 'Taxed', due: '2027-08-01' }, mot: { status: 'Valid', due: '2026-11-30' } });
  assert.equal(JSON.stringify(v).includes('V5C'), false, 'nothing else is passed on');
  assert.equal(dvla.readVehicle({ motExpiry: '2026-12-01' }).mot.due, '2026-12-01', 'the example field name works too');
  assert.equal(dvla.readVehicle({ fuelType: 'HYBRID ELECTRIC' }).fuel, 'hybrid');
  assert.equal(dvla.readVehicle({ fuelType: 'GAS BI-FUEL' }).fuel, 'other');
  assert.equal(dvla.readVehicle({ taxDueDate: 'tomorrow', yearOfManufacture: '2016' }).year, null);
  assert.deepEqual(dvla.readVehicle(null).tax, { status: '', due: '' });
});

test('one POST with the key in a header and only the plate in the body; errors become plain sentences', async () => {
  let seen;
  const out = await dvla.lookup({ key: 'k'.repeat(30), plate: 'ab12 cde', base: 'https://dvla.test/v1', fetchImpl: async (url, init) => { seen = { url, init }; return json(200, REPLY); } });
  assert.equal(out.make, 'Volkswagen');
  assert.equal(seen.url, 'https://dvla.test/v1');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-api-key'], 'k'.repeat(30));
  assert.deepEqual(JSON.parse(seen.init.body), { registrationNumber: 'AB12CDE' });
  assert.equal(seen.init.redirect, 'error');
  const fail = (status) => dvla.lookup({ key: 'k', plate: 'AB12CDE', fetchImpl: async () => new Response('{}', { status }) }).catch((e) => e);
  assert.match((await fail(404)).message, /no car with that/);
  assert.equal((await fail(404)).status, 404);
  assert.match((await fail(403)).message, /refused the key/);
  assert.match((await fail(429)).message, /busy/);
  assert.match((await fail(503)).message, /problem/);
  assert.match((await dvla.lookup({ key: 'k', plate: 'AB12CDE', fetchImpl: async () => { throw new Error('down'); } }).catch((e) => e)).message, /Couldn’t reach/);
  assert.match((await dvla.lookup({ key: 'k', plate: '', fetchImpl: async () => json(200, {}) }).catch((e) => e)).message, /number plate/);
});

let server;
let base;
let dataDir;
let admin;
let sam;
let mia;
let calls = [];
let reply = () => json(200, REPLY);
const ids = {};

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-dvla-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300, coffeeOptions: { dvlaFetch: async (url, init) => { calls.push({ url, init }); return reply(); } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  for (const name of ['sam', 'mia']) {
    const made = await call('POST', '/api/admin/users', { username: name, password: 'password1', limitGb: 1, apps: ['cars'] }, admin);
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

test('off until an admin saves a key: no button, and the lookup says so', async () => {
  const car = (await call('POST', '/api/cars', { name: 'Golf', plate: 'ab12 cde' }, sam)).body;
  ids.car = car.id;
  assert.equal((await call('GET', '/api/cars', null, sam)).body.dvla, false);
  const off = await call('POST', `/api/cars/${car.id}/dvla`, null, sam);
  assert.equal(off.status, 409);
  assert.equal(calls.length, 0, 'nothing is sent anywhere');
});

test('only an admin can save the key; it is stored sealed and never sent back', async () => {
  const KEY = 'AbCdEf0123456789AbCdEf0123456789';
  assert.equal((await call('PUT', '/api/admin/cars-dvla', { key: KEY }, sam)).status, 403);
  assert.equal((await call('PUT', '/api/admin/cars-dvla', { key: 'bad key!' }, admin)).status, 400);
  const saved = await call('PUT', '/api/admin/cars-dvla', { key: KEY }, admin);
  assert.deepEqual(saved.body, { on: true, last4: KEY.slice(-4), lastOk: null });
  const settings = await call('GET', '/api/admin/settings', null, admin);
  assert.deepEqual(settings.body.settings.carsDvla, { on: true, last4: KEY.slice(-4), lastOk: null });
  assert.equal(JSON.stringify(settings.body).includes(KEY), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8').includes(KEY), false, 'not on disk in the clear');
  ids.key = KEY;
});

test('the owner presses the button: one request, plate only, a suggestion back, nothing stored', async () => {
  assert.equal((await call('GET', '/api/cars', null, sam)).body.dvla, true);
  const out = await call('POST', `/api/cars/${ids.car}/dvla`, null, sam);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.mot.due, '2026-11-30');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-api-key'], ids.key);
  assert.deepEqual(JSON.parse(calls[0].init.body), { registrationNumber: 'AB12CDE' });
  const car = (await call('GET', `/api/cars/${ids.car}`, null, sam)).body;
  assert.equal(car.make, '', 'the car is unchanged until the person confirms');
  assert.ok((await call('GET', '/api/admin/settings', null, admin)).body.settings.carsDvla.lastOk, 'a good answer is noted');
});

test('too quick a second press is held back; only the owner can use it; errors are plain', async () => {
  assert.equal((await call('POST', `/api/cars/${ids.car}/dvla`, null, sam)).status, 429);
  await call('PUT', `/api/cars/${ids.car}/share`, { shares: [{ userId: ids.mia, role: 'editor' }] }, sam);
  assert.equal((await call('POST', `/api/cars/${ids.car}/dvla`, null, mia)).status, 403, 'an editor can’t');
  assert.equal((await call('POST', `/api/cars/${ids.car}/dvla`, null, admin)).status, 404);
  await new Promise((r) => setTimeout(r, 3100));
  reply = () => json(404, {});
  const missing = await call('POST', `/api/cars/${ids.car}/dvla`, null, sam);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no car with that/);
  const bare = (await call('POST', '/api/cars', { name: 'Bare' }, sam)).body;
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal((await call('POST', `/api/cars/${bare.id}/dvla`, null, sam)).status, 400, 'no plate, nothing sent');
  assert.equal(calls.length, 2);
});

test('removing the key switches the lookup off again', async () => {
  const off = await call('PUT', '/api/admin/cars-dvla', { remove: true }, admin);
  assert.deepEqual(off.body, { on: false, last4: '', lastOk: null });
  assert.equal((await call('GET', '/api/cars', null, sam)).body.dvla, false);
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal((await call('POST', `/api/cars/${ids.car}/dvla`, null, sam)).status, 409);
});
