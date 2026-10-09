'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { createSearch } = require('../src/search');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let admin;
let sam;
let samId;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-search-test-'));
  server = createServer({ dataDir, probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  samId = (await call('POST', '/api/admin/users', { username: 'sam', password: 'password1' }, admin)).body.user.id;
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

async function upload(cookie, parent, name) {
  const res = await call('POST', '/api/nest/uploads', { parent, name, size: 0 }, cookie);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.item;
}

const find = async (q, cookie = sam) => call('GET', `/api/search?q=${encodeURIComponent(q)}`, null, cookie);
const nestHits = (res) => res.body.groups.find((g) => g.app === 'nest').items;

test('search needs a signed-in user', async () => {
  assert.equal((await find('tax', null)).status, 401);
});

test('finds Nest files and folders by name, with where they are', async () => {
  const work = (await call('POST', '/api/nest/folders', { parent: 'root', name: 'Work' }, sam)).body.item;
  const taxes = (await call('POST', '/api/nest/folders', { parent: work.id, name: 'Taxes 2026' }, sam)).body.item;
  const file = await upload(sam, taxes.id, 'Tax return.pdf');
  await upload(sam, 'root', 'holiday.jpg');

  const res = await find('  TAX  ');
  assert.equal(res.status, 200);
  assert.equal(res.body.q, 'TAX');
  const hits = nestHits(res);
  assert.deepEqual(hits.map((h) => h.name).sort(), ['Tax return.pdf', 'Taxes 2026']);
  const hit = hits.find((h) => h.id === file.id);
  assert.equal(hit.detail, 'My Drive / Work / Taxes 2026');
  assert.equal(hit.href, `#/nest/f/${taxes.id}/${file.id}`);
  assert.equal(hits.find((h) => h.id === taxes.id).href, `#/nest/f/${taxes.id}`);

  // Every word must match, in any order; names starting with the first word come first.
  assert.deepEqual(nestHits(await find('return tax')).map((h) => h.name), ['Tax return.pdf']);
  assert.deepEqual(nestHits(await find('holi')).map((h) => h.name), ['holiday.jpg']);
});

test('% and _ are matched as plain letters', async () => {
  await upload(sam, 'root', '100%_done.txt');
  await upload(sam, 'root', '100 xdone.txt');
  assert.deepEqual(nestHits(await find('0%_')).map((h) => h.name), ['100%_done.txt']);
});

test('one letter returns nothing, and nothing is searched', async () => {
  const res = await find('t');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.groups, []);
});

test('trashed items and other people’s files stay out of results', async () => {
  const gone = await upload(sam, 'root', 'secret plans.txt');
  await call('POST', '/api/nest/trash', { ids: [gone.id] }, sam);
  assert.deepEqual(nestHits(await find('secret')), []);
  assert.deepEqual(nestHits(await find('tax', admin)), []);
});

test('apps the user can’t open are not searched', async () => {
  assert.deepEqual((await call('GET', '/api/apps', null, sam)).body.searchable, ['nest']);
  await call('PATCH', `/api/admin/users/${samId}`, { apps: ['jellyfin'] }, admin);
  assert.deepEqual((await find('tax')).body.groups, []);
  assert.deepEqual((await call('GET', '/api/apps', null, sam)).body.searchable, []);
  await call('PATCH', `/api/admin/users/${samId}`, { apps: ['jellyfin', 'nest'] }, admin);
});

test('a slow or broken app does not hold up the others', async () => {
  const apps = [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Slow' }, { id: 'c', name: 'Broken' }];
  const s = createSearch({
    timeoutMs: 50,
    visibleApps: () => apps,
    sources: [
      { app: 'a', search: () => ({ items: [{ id: '1', name: 'one' }], more: true }) },
      { app: 'b', search: () => new Promise((r) => setTimeout(() => r({ items: [] }), 1000).unref()) },
      { app: 'c', search: () => { throw new Error('boom'); } },
      { app: 'hidden', search: () => assert.fail('apps the user can’t open are never asked') },
    ],
  });
  const original = console.error;
  console.error = () => {};
  const started = Date.now();
  const { groups } = await s.run({}, 'on').finally(() => { console.error = original; });
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(groups.map((g) => [g.app, g.items.length, g.more, Boolean(g.error)]), [
    ['a', 1, true, false],
    ['b', 0, false, true],
    ['c', 0, false, true],
  ]);
});
