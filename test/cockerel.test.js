'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cockerel, GB } = require('../src/cockerel');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const SECRET = 'a-long-shared-secret-for-tests-1234';

function unit(settings = {}, now = Date.now()) {
  const store = { db: { settings: { cockerel: { url: 'http://192.168.4.40:7070', secret: SECRET, ...settings } } }, save() {} };
  let n = 0;
  return new Cockerel({ store, newId: () => `id${++n}`, now: () => now });
}

test('only a fresh, correctly signed message from the VM is believed', () => {
  const c = unit();
  const body = JSON.stringify({ type: 'log', text: 'hi' });
  const h = c.headers(body);
  assert.equal(c.verify(h, body), true);
  assert.equal(c.verify(h, body + ' '), false, 'changed body');
  assert.equal(c.verify({ ...h, 'x-roost-sig': 'f'.repeat(64) }, body), false, 'wrong signature');
  assert.equal(c.verify({}, body), false, 'unsigned');
  const old = unit({}, Date.now() - 10 * 60 * 1000).headers(body);
  assert.equal(c.verify(old, body), false, 'stale');
  assert.equal(unit({ secret: '' }).verify(h, body), false, 'not set up');
});

test('under the limits he acts alone; over them he asks', () => {
  const c = unit({ sizeGb: 5, dayGb: 8 });
  assert.equal(c.check(2 * GB).decision, 'auto');
  assert.equal(c.check(6 * GB).decision, 'ask');
  assert.equal(c.check(0).decision, 'ask', 'unknown size');
  c.spend(4 * GB);
  assert.equal(c.check(5 * GB).decision, 'ask', 'would pass the day allowance');
  assert.equal(c.check(3 * GB).decision, 'auto');
});

test('the day allowance starts again tomorrow', () => {
  let now = Date.UTC(2026, 9, 30, 12);
  const store = { db: { settings: { cockerel: { url: 'http://10.0.0.2:7070', secret: SECRET } } }, save() {} };
  const c = new Cockerel({ store, newId: () => 'x', now: () => now });
  c.spend(3 * GB);
  assert.equal(c.dayBytes(), 3 * GB);
  now += 24 * 3600 * 1000;
  assert.equal(c.dayBytes(), 0);
});

test('the feed and jobs keep only the latest', () => {
  const c = unit();
  for (let i = 0; i < 230; i++) c.add({ kind: 'note', text: `n${i}` });
  assert.equal(c.data().log.length, 200);
  c.setJob({ id: 'j1', title: 'Big Buck Bunny', state: 'Downloading', progress: 140 });
  assert.equal(c.data().jobs[0].progress, 100);
  c.setJob({ id: 'j1', state: 'nonsense' });
  assert.equal(c.data().jobs[0].state, 'Downloading');
});

// ---------- through the server ----------
let server;
let base;
let dataDir;
let cookie;
const sent = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-cockerel-'));
  const fetchImpl = async (url, opts) => {
    sent.push({ url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    return new Response(JSON.stringify(url.endsWith('/chat') ? { reply: 'On it.' } : { ok: true }), { status: 200 });
  };
  server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', coffeeOptions: { fetchImpl } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, cookie);
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, ck, headers = {}, raw) {
  const h = { ...headers };
  if (body !== undefined && body !== null && !raw) h['Content-Type'] = 'application/json';
  if (raw) h['Content-Type'] = 'application/json';
  if (ck) h.Cookie = ck;
  const res = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* none */ }
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: set ? set.split(';')[0] : undefined };
}

function signed(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-roost-ts': ts, 'x-roost-sig': crypto.createHmac('sha256', SECRET).update(`${ts}\n${body}`).digest('hex') };
}

const hook = (payload) => { const raw = JSON.stringify(payload); return call('POST', '/api/cockerel/hook', null, null, signed(raw), raw); };

test('Cockerel is for admins only', async () => {
  assert.equal((await call('GET', '/api/cockerel')).status, 401);
  assert.equal((await call('POST', '/api/cockerel/chat', { text: 'hi' })).status, 401);
});

test('admin links him, and the secret never comes back', async () => {
  const bad = await call('PUT', '/api/admin/cockerel', { url: 'http://example.com:7070' }, cookie);
  assert.equal(bad.status, 400, 'only home-network addresses');
  const ok = await call('PUT', '/api/admin/cockerel', { url: 'http://192.168.4.40:7070', secret: SECRET, sizeGb: 4, dayGb: 12 }, cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { url: 'http://192.168.4.40:7070', hasSecret: true, paused: false, sizeGb: 4, dayGb: 12 });
  const settings = await call('GET', '/api/admin/settings', null, cookie);
  assert.ok(!JSON.stringify(settings.body).includes(SECRET));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8').includes(SECRET), 'kept encrypted');
});

test('a chat message goes to the VM signed and the reply comes back', async () => {
  const r = await call('POST', '/api/cockerel/chat', { text: 'Is Big Buck Bunny in the library?' }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply.text, 'On it.');
  const hit = sent.find((s) => s.url.endsWith('/chat'));
  assert.equal(hit.body.text, 'Is Big Buck Bunny in the library?');
  assert.match(hit.headers['x-roost-sig'], /^[0-9a-f]{64}$/);
  const feed = await call('GET', '/api/cockerel', null, cookie);
  assert.deepEqual(feed.body.log.slice(-2).map((e) => e.kind), ['you', 'cockerel']);
});

test('the VM can only report with a good signature', async () => {
  assert.equal((await call('POST', '/api/cockerel/hook', { type: 'log', text: 'x' })).status, 401);
  assert.equal((await hook({ type: 'log', text: 'Checked the library' })).status, 200);
  assert.equal((await hook({ type: 'job', id: 'j1', title: 'Sintel', state: 'Finding' })).body.job.state, 'Finding');
  assert.equal((await hook({ type: 'check', bytes: 1 * GB })).body.decision, 'auto');
  assert.equal((await hook({ type: 'check', bytes: 9 * GB })).body.decision, 'ask');
  assert.equal((await hook({ type: 'nope' })).status, 400);
});

test('his question reaches Raven and the answer goes back', async () => {
  assert.equal((await hook({ type: 'ask', askId: 'a1', text: 'Sintel was requested. Find it?', options: ['Yes', 'No'] })).status, 200);
  const ask = (await call('GET', '/api/cockerel', null, cookie)).body.log.find((e) => e.kind === 'ask');
  assert.deepEqual(ask.options, ['Yes', 'No']);
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Maybe' }, cookie)).status, 400);
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Yes' }, cookie)).status, 200);
  assert.deepEqual(sent.find((s) => s.url.endsWith('/answer')).body, { askId: 'a1', choice: 'Yes' });
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'No' }, cookie)).status, 409, 'once only');
});

test('a movie request wakes him', async () => {
  sent.length = 0;
  server.push.notify({ title: 'Movie request', body: 'Sam asks for Sintel', tag: 'movie-1', url: '/#/admin' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.find((s) => s.url.endsWith('/event')).body.body, 'Sam asks for Sintel');
  sent.length = 0;
  server.push.notify({ title: 'Now on Roostflix', body: 'Sintel', tag: 'movie-1', url: '/' }, 'someone-else');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0, 'a note to one person is not for him');
});

test('paused, he hears nothing and does nothing', async () => {
  await call('PUT', '/api/admin/cockerel', { paused: true }, cookie);
  sent.length = 0;
  server.push.notify({ title: 'Movie request', body: 'x', tag: 't' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
  assert.equal((await call('POST', '/api/cockerel/chat', { text: 'hi' }, cookie)).status, 409);
  assert.equal((await hook({ type: 'check', bytes: 1 })).status, 409, 'nothing new starts');
  assert.equal((await hook({ type: 'job', id: 'j2', title: 'x' })).status, 200, 'a running download can still be filed');
  await call('PUT', '/api/admin/cockerel', { paused: false }, cookie);
});
