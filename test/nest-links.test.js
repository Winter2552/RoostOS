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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-links-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  await call('POST', '/api/admin/users', { username: 'sam', password: 'password1', limitGb: 1 }, admin);
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

async function put(cookie, name, text) {
  const buf = Buffer.from(text);
  const start = await call('POST', '/api/nest/uploads', { parent: '', name, size: buf.length }, cookie);
  if (start.body.done) return start.body.item;
  const res = await fetch(`${base}/api/nest/uploads/${start.body.id}?offset=0`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: buf });
  return (await res.json()).item;
}

const visit = (url, init = {}) => fetch(base + url, { redirect: 'manual', ...init });

test('a link opens one file with no sign-in, and only that file', async () => {
  const file = await put(sam, 'note.txt', 'hello link');
  await put(sam, 'other.txt', 'private');
  const made = await call('POST', '/api/nest/shares', { id: file.id, days: 7 }, sam);
  assert.equal(made.status, 201);
  const { token, url } = made.body.share;
  assert.ok(token.length >= 32);
  assert.ok(url.endsWith(`/s/${token}`));

  const page = await visit(`/s/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /note\.txt/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const dl = await visit(`/s/${token}/file`);
  assert.equal(await dl.text(), 'hello link');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await visit(`/s/${token}/view`)).status, 404, 'text files only download');
  assert.equal((await visit('/api/nest/folders/root')).status, 401, 'the rest of Nest still needs sign-in');

  const list = await call('GET', `/api/nest/shares?id=${file.id}`, null, sam);
  assert.equal(list.body.shares[0].downloads, 1);
  assert.equal((await call('GET', `/api/nest/shares?id=${file.id}`, null, admin)).status, 404, 'others can\'t list my links');
});

test('a password is needed, and a wrong one is turned away', async () => {
  const file = await put(sam, 'secret.txt', 'top secret');
  const { token } = (await call('POST', '/api/nest/shares', { id: file.id, password: 'open sesame' }, sam)).body.share;
  assert.equal((await visit(`/s/${token}/file`)).status, 401);
  const form = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  assert.equal((await visit(`/s/${token}`, { ...form, body: 'password=nope' })).status, 401);
  const ok = await visit(`/s/${token}`, { ...form, body: 'password=open%20sesame' });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal(await (await visit(`/s/${token}/file`, { headers: { Cookie: cookie } })).text(), 'top secret');
});

test('links stop when removed, expired, trashed or switched off', async () => {
  const file = await put(sam, 'gone.txt', 'bye');
  const mk = async () => (await call('POST', '/api/nest/shares', { id: file.id }, sam)).body.share.token;

  const a = await mk();
  assert.equal((await call('DELETE', `/api/nest/shares/${a}`, null, admin)).status, 200);
  assert.equal((await visit(`/s/${a}`)).status, 200, 'another person can\'t remove it');
  await call('DELETE', `/api/nest/shares/${a}`, null, sam);
  assert.equal((await visit(`/s/${a}`)).status, 404);

  const b = await mk();
  server.nest.db.prepare('UPDATE shares SET expires = ? WHERE token = ?').run(Date.now() - 1000, b);
  assert.equal((await visit(`/s/${b}`)).status, 404);

  const c = await mk();
  await call('POST', '/api/nest/trash', { ids: [file.id] }, sam);
  assert.equal((await visit(`/s/${c}`)).status, 404);
  await call('POST', '/api/nest/restore', { ids: [file.id] }, sam);
  assert.equal((await visit(`/s/${c}`)).status, 200);

  await call('PATCH', '/api/admin/settings', { publicLinks: false }, admin);
  assert.equal((await visit(`/s/${c}`)).status, 404);
  assert.equal((await call('POST', '/api/nest/shares', { id: file.id }, sam)).status, 403);
  await call('PATCH', '/api/admin/settings', { publicLinks: true }, admin);
});

test('guessing tokens gets a visitor blocked, and folders can\'t be shared', async () => {
  const folder = await call('POST', '/api/nest/folders', { parent: '', name: 'Docs' }, sam);
  assert.equal((await call('POST', '/api/nest/shares', { id: folder.body.item.id }, sam)).status, 404);
  assert.equal((await call('POST', '/api/nest/shares', { id: 'nope' }, sam)).status, 404);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await visit(`/s/${'x'.repeat(30)}${i}`)).status;
  assert.equal(last, 429);
});
