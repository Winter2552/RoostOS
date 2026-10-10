'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const galaxies = require('../src/galaxies');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const DOMAIN = 'roostos.network';

test('a name becomes a short address; odd names are refused', () => {
  assert.equal(galaxies.slug('Books'), 'books');
  assert.equal(galaxies.slug('  My Books! '), 'my-books');
  assert.equal(galaxies.slug('9lives'), '');
  assert.equal(galaxies.slug('x'), '');
  assert.equal(galaxies.slug('a'.repeat(40)).length, 24);
});

test('where a galaxy listens: a port alone means this box; Roost\'s own port is refused', () => {
  assert.deepEqual(galaxies.parseAddress('8200'), { host: galaxies.HOST, port: 8200 });
  assert.deepEqual(galaxies.parseAddress('192.168.4.35:8200'), { host: '192.168.4.35', port: 8200 });
  assert.deepEqual(galaxies.parseAddress('Books-App:9000'), { host: 'books-app', port: 9000 });
  for (const bad of ['', '8080', '0', '70000', 'x y:80', 'host:', 'http://a:80', 'a/b:80', '-a:80']) assert.equal(galaxies.parseAddress(bad), null, bad);
});

test('the admin view never carries the secret, and the compose file only when it is passed in', () => {
  const g = { id: 'books', name: 'Books', address: 'host.docker.internal:8200', image: 'ghcr.io/me/books:1', secret: 'ab'.repeat(32), enabled: true };
  assert.equal(JSON.stringify(galaxies.view(g, DOMAIN)).includes(g.secret), false);
  assert.equal(galaxies.view(g, DOMAIN).openUrl, `https://nova.${DOMAIN}/books/`);
  assert.equal(galaxies.view({ ...g, enabled: false }, DOMAIN).openUrl, '');
  assert.equal(galaxies.compose(g).includes(g.secret), false);
  assert.match(galaxies.compose(g, g.secret), new RegExp(g.secret));
  assert.match(galaxies.compose(g), /GALAXY_BASE_PATH: \/books/);
  assert.match(galaxies.compose(g), /"8200:8200"/);
  assert.equal(galaxies.cleanImage('ghcr.io/me/books:1'), 'ghcr.io/me/books:1');
  assert.equal(galaxies.cleanImage('bad image'), null);
  assert.equal(galaxies.cleanImage(''), '');
});

// ---------- through the server ----------

let server;
let upstream;
let base;
let dataDir;
let admin;
let seen = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/__health') return res.end('ok');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello from books');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-galaxies-'));
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', coffeeOptions: { fetchImpl: (url, init) => fetch(url, init) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  await call('POST', '/api/admin/users', { username: 'mia', password: 'password1', apps: ['jellyfin'] }, admin);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
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

function nova(pathname, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { headers: { host: `nova.${DOMAIN}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const login = async (username) => (await call('POST', '/api/login', { username, password: 'password1' })).cookie;
let secret = '';

test('only an admin can see or change galaxies', async () => {
  assert.equal((await call('GET', '/api/admin/galaxies')).status, 401);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Books', port: '8200' })).status, 401);
  const mia = await login('mia');
  assert.equal((await call('GET', '/api/admin/galaxies', null, mia)).status, 403);
  assert.equal((await call('DELETE', '/api/admin/galaxies/books', null, mia)).status, 403);
});

test('adding needs a name and a sensible port, and refuses taken names', async () => {
  assert.equal((await call('POST', '/api/admin/galaxies', { port: '8200' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Books' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Books', port: '8080' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Books', port: '8200', image: 'bad image' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Coffee', port: '8200' }, admin)).status, 409);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Admin', port: '8200' }, admin)).status, 409);
});

test('adding makes the card and a secret shown once; it stays off until the domain is set', async () => {
  const added = await call('POST', `/api/admin/galaxies`, { name: 'Books', port: `127.0.0.1:${upstream.address().port}`, image: 'ghcr.io/me/books:1' }, admin);
  assert.equal(added.status, 201);
  secret = added.body.secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.match(added.body.compose, new RegExp(secret));
  const g = added.body.galaxies.find((x) => x.id === 'books');
  assert.equal(g.enabled, false);
  assert.equal(g.secretSaved, true);
  assert.equal((await call('POST', '/api/admin/galaxies', { name: 'Books', port: '8200' }, admin)).status, 409);
  const apps = (await call('GET', '/api/apps', null, admin)).body.apps;
  assert.ok(apps.some((a) => a.id === 'galaxy-books' && a.name === 'Books'));
  // The secret never comes back from any other call.
  for (const url of ['/api/admin/galaxies', '/api/admin/settings', '/api/admin/setup', '/api/admin/galaxies/books/compose']) {
    assert.equal(JSON.stringify((await call('GET', url, null, admin)).body).includes(secret), false, url);
  }
  assert.equal((await call('PUT', '/api/admin/galaxies/books', { enabled: true }, admin)).status, 400);
});

test('with the domain set it switches on, and Check reaches the container', async () => {
  await call('PUT', '/api/admin/tls', { domain: DOMAIN, token: 'tok', renew: false }, admin);
  const on = await call('PUT', '/api/admin/galaxies/books', { enabled: true }, admin);
  assert.equal(on.status, 200);
  assert.equal(on.body.galaxies[0].openUrl, `https://nova.${DOMAIN}/books/`);
  const checked = await call('POST', '/api/admin/galaxies/books/check', null, admin);
  assert.equal(checked.body.galaxies[0].check.ok, true);
  assert.equal((await call('POST', '/api/admin/galaxies/nope/check', null, admin)).status, 404);
  // The card's dot says whether it is answering.
  assert.equal((await call('GET', '/api/apps/status', null, admin)).body.status['galaxy-books'], 'online');
  // The homepage card opens it.
  const card = (await call('GET', '/api/apps', null, admin)).body.apps.find((a) => a.id === 'galaxy-books');
  assert.equal(card.openUrl, `https://nova.${DOMAIN}/books/`);
});

test('signed-out browsers go to Roost and come back to the galaxy', async () => {
  const page = await nova('/books/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, `https://${DOMAIN}/?next=books`);
  assert.equal((await nova('/books/x', { headers: { accept: 'application/json' } })).status, 401);
  assert.equal((await nova('/books')).headers.location, '/books/');
  assert.equal((await nova('/nope/')).status, 404);
  assert.equal((await nova('/coffee/')).status, 404);
});

test('only people with the galaxy get through, with a signed header and the prefix stripped', async () => {
  const mia = await login('mia');
  assert.equal((await nova('/books/', { headers: { cookie: mia } })).status, 403);
  await call('PATCH', `/api/admin/users/${(await call('GET', '/api/admin/users', null, admin)).body.users.find((u) => u.username === 'mia').id}`, { apps: ['jellyfin', 'galaxy-books'] }, admin);
  seen = [];
  const out = await nova('/books/shelf?x=1', { headers: { cookie: mia, 'x-roost-user': 'root', 'x-roost-admin': '1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.toString(), 'hello from books');
  const got = seen.at(-1);
  assert.equal(got.url, '/shelf?x=1');
  assert.equal(got.headers['x-roost-user'], 'mia');
  assert.equal(got.headers['x-roost-admin'], '0');
  const expected = crypto.createHmac('sha256', secret).update(`${got.headers['x-roost-ts']}\nmia\n0`).digest('hex');
  assert.equal(got.headers['x-roost-sig'], expected);
  assert.equal(got.headers.cookie, undefined);
});

test('open paths pass without a sign-in, and nothing else does', async () => {
  seen = [];
  assert.equal((await nova('/books/__health')).status, 200);
  assert.equal(seen.at(-1).headers['x-roost-user'], undefined);
  // Coffee Galaxy's phone-app path is Coffee's alone.
  assert.equal((await nova('/books/__vanstock/helper', { headers: { accept: 'application/json' } })).status, 401);
});

test('a new secret replaces the old one, and the gateway signs with it', async () => {
  const made = await call('POST', '/api/admin/galaxies/books/secret', null, admin);
  assert.equal(made.status, 200);
  assert.notEqual(made.body.secret, secret);
  secret = made.body.secret;
  seen = [];
  const mia = await login('mia');
  await nova('/books/', { headers: { cookie: mia } });
  const got = seen.at(-1);
  assert.equal(got.headers['x-roost-sig'], crypto.createHmac('sha256', secret).update(`${got.headers['x-roost-ts']}\nmia\n0`).digest('hex'));
});

test('turned off, it disappears; removed, its card and ticks go too', async () => {
  const mia = await login('mia');
  await call('PUT', '/api/admin/galaxies/books', { enabled: false }, admin);
  seen = [];
  await nova('/books/', { headers: { cookie: mia } });
  assert.equal(seen.length, 0, 'nothing reaches the container once it is off');
  const gone = await call('DELETE', '/api/admin/galaxies/books', null, admin);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.galaxies, []);
  assert.equal((await call('GET', '/api/apps', null, admin)).body.apps.some((a) => a.id === 'galaxy-books'), false);
  const me = (await call('GET', '/api/admin/users', null, admin)).body.users.find((u) => u.username === 'mia');
  assert.equal((me.apps || []).includes('galaxy-books'), false);
});
