'use strict';

// Signing in a TV with a code: the code rules on their own, then the whole
// flow against a small fake Jellyfin that has Quick Connect.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { TvCodes, clean, show, tvName } = require('../src/tvcode');

test('codes read the same however they are typed', () => {
  assert.equal(clean('k7m2 qx9p'), 'K7M2QX9P');
  assert.equal(clean('K7M2-QX9P'), 'K7M2QX9P');
  assert.equal(show('K7M2QX9P'), 'K7M2-QX9P');
  assert.equal(tvName('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) Samsung'), 'Samsung TV');
  assert.equal(tvName('Mozilla/5.0 (Windows NT 10.0)'), 'Browser');
});

test('a code is 8 characters without look-alikes, works once and then ends', async () => {
  const codes = new TvCodes();
  const made = codes.start({ name: 'Samsung TV', ip: '1.1.1.1' });
  assert.match(made.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
  assert.equal(made.display.length, 9);
  assert.equal(codes.lookup(made.display.toLowerCase(), { userId: 'u1', ip: '2.2.2.2' }).name, 'Samsung TV');
  const waiting = codes.wait(made.secret, 5000);
  assert.ok(codes.decide(made.display, 'u1', true, 'jf-token'));
  const got = await waiting;
  assert.deepEqual([got.state, got.userId, got.approverJf], ['approved', 'u1', 'jf-token']);
  // Until the TV has its sign-in, asking again gives the same answer; after, nothing.
  assert.equal((await codes.wait(made.secret, 50)).state, 'approved');
  codes.finish(made.secret);
  assert.equal((await codes.wait(made.secret, 50)).state, 'expired');
  assert.equal(codes.decide(made.code, 'u1', true), null);
});

test('a code runs out after ten minutes and a turned-down one says so', async () => {
  let t = 1000;
  const codes = new TvCodes({ now: () => t });
  const a = codes.start({ name: 'TV', ip: '1.1.1.1' });
  t += 10 * 60 * 1000 + 1;
  assert.equal(codes.lookup(a.code, { userId: 'u1', ip: '2.2.2.2' }), null);
  assert.equal((await codes.wait(a.secret, 50)).state, 'expired');
  const b = codes.start({ name: 'TV', ip: '1.1.1.1' });
  codes.decide(b.code, 'u1', false);
  assert.equal((await codes.wait(b.secret, 50)).state, 'denied');
});

test('guessing is limited per person and an address asks for few codes', () => {
  const codes = new TvCodes();
  const made = codes.start({ name: 'TV', ip: '1.1.1.1' });
  for (let i = 0; i < 5; i++) assert.equal(codes.lookup('AAAAAAAA', { userId: 'u1', ip: `9.9.9.${i}` }), null);
  // Five wrong from one account: even the right code is held back for a while.
  assert.deepEqual(codes.lookup(made.code, { userId: 'u1', ip: '8.8.8.8' }), { limited: true });
  assert.ok(codes.lookup(made.code, { userId: 'u2', ip: '8.8.8.8' }).name);
  // Only three codes per address are alive at once; the oldest goes.
  const ip = '3.3.3.3';
  const first = codes.start({ name: 'TV', ip });
  for (let i = 0; i < 3; i++) codes.start({ name: 'TV', ip });
  assert.equal(codes.lookup(first.code, { userId: 'u3', ip: '4.4.4.4' }), null);
  // And an address can't ask without end.
  const spam = new TvCodes();
  let refused = 0;
  for (let i = 0; i < 12; i++) if (!spam.start({ name: 'TV', ip: '5.5.5.5' })) refused += 1;
  assert.equal(refused, 2);
});

test('waiting is held open and ends the moment someone approves', async () => {
  const codes = new TvCodes();
  const made = codes.start({ name: 'TV', ip: '1.1.1.1' });
  const t0 = Date.now();
  const waiting = codes.wait(made.secret, 5000);
  setTimeout(() => codes.decide(made.code, 'u1', true), 30);
  assert.equal((await waiting).state, 'approved');
  assert.ok(Date.now() - t0 < 1000);
  const idle = codes.start({ name: 'TV', ip: '1.1.1.2' });
  assert.equal((await codes.wait(idle.secret, 40)).state, 'pending');
});

// ---------- the whole flow ----------

const KEY = 'fake-api-key';
let fake;
let server;
let base;
let dataDir;
let jfUrl;
const jf = { quick: true, tokens: new Map(), seen: [], pending: new Map(), users: [] };

function fakeJellyfin() {
  let n = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const auth = req.headers.authorization || '';
    const token = (auth.match(/Token="([^"]+)"/) || [])[1];
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    jf.seen.push({ method: req.method, url: req.url, token });
    if (req.url === '/System/Info') return token === KEY ? json(200, { ServerName: 'Home', Version: '10.10.7' }) : json(401);
    if (req.url === '/Users' && req.method === 'GET') return token === KEY ? json(200, jf.users) : json(401);
    if (req.url === '/Users/New') {
      const u = { Id: `u${++n}`, Name: body.Name, Password: body.Password, Policy: { IsAdministrator: false, IsDisabled: false } };
      jf.users.push(u);
      return json(200, u);
    }
    const pm = req.url.match(/^\/Users\/(\w+)\/(Password|Policy)$/);
    if (pm) {
      const u = jf.users.find((x) => x.Id === pm[1]);
      if (pm[2] === 'Password') u.Password = body.NewPw;
      else u.Policy = body;
      return json(204);
    }
    if (req.url === '/Users/AuthenticateByName') {
      const u = jf.users.find((x) => x.Name === body.Username && x.Password === body.Pw);
      if (!u) return json(401);
      const t = `tok${++n}`;
      jf.tokens.set(t, u.Id);
      return json(200, { AccessToken: t, ServerId: 'server1', User: { Id: u.Id } });
    }
    if (req.url === '/System/Configuration') {
      if (req.method === 'GET') return json(200, { QuickConnectAvailable: jf.quick, Other: 1 });
      jf.quick = body.QuickConnectAvailable === true;
      return json(204);
    }
    if (req.url === '/QuickConnect/Initiate') {
      if (!jf.quick) return json(401);
      const code = String(100000 + ++n);
      jf.pending.set(code, { secret: `secret${n}`, user: null });
      return json(200, { Code: code, Secret: jf.pending.get(code).secret });
    }
    let m = req.url.match(/^\/QuickConnect\/Authorize\?code=(\d+)$/);
    if (m) {
      if (!jf.tokens.has(token)) return json(401);
      jf.pending.get(m[1]).user = jf.tokens.get(token);
      return json(200, true);
    }
    if (req.url === '/Users/AuthenticateWithQuickConnect') {
      const hit = [...jf.pending.values()].find((p) => p.secret === body.Secret && p.user);
      if (!hit) return json(401);
      const t = `tok${++n}`;
      jf.tokens.set(t, hit.user);
      return json(200, { AccessToken: t, ServerId: 'server1', User: { Id: hit.user } });
    }
    if (req.url === '/Sessions/Logout') { jf.tokens.delete(token); return json(204); }
    if (req.url.startsWith('/web/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('jellyfin web'); }
    json(404);
  });
}

async function call(method, url, body, cookie, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const session = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('roost_session=') && c !== 'roost_session=');
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, cookie: session || null };
}

before(async () => {
  fake = fakeJellyfin();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  jfUrl = `http://127.0.0.1:${fake.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-tv-'));
  server = createServer({ dataDir, maxFailedSignIns: 50 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const TV = { 'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) Samsung' };
const settle = () => new Promise((r) => setTimeout(r, 200));

test('without Roostflix set up there is nothing to sign a TV in to', async () => {
  assert.equal((await call('POST', '/api/tv/start', {}, null, TV)).status, 404);
});

test('a TV is signed in from a phone and can only open Roostflix', async () => {
  // Raven signs in (and so does Jellyfin) before Jellyfin is set up for Roost.
  const setup = await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' });
  const raven = setup.cookie;
  const { setUpTwoStep } = require('./helpers');
  await setUpTwoStep(call, raven);
  assert.equal((await call('PUT', '/api/admin/jellyfin', { url: jfUrl, apiKey: KEY }, raven)).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { username: 'mia', password: 'mia pass 12', apps: ['jellyfin'] }, raven)).status, 201);
  const phone = (await call('POST', '/api/login', { username: 'mia', password: 'mia pass 12' })).cookie;
  assert.ok(phone);
  await settle();

  const start = await call('POST', '/api/tv/start', {}, null, TV);
  assert.equal(start.status, 200);
  assert.match(start.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(start.body.qr, /<svg/);
  assert.match(start.body.address, /\/code$/);

  // Not signed in: can't look at a code.
  assert.equal((await call('POST', '/api/tv/lookup', { code: start.body.code })).status, 401);
  assert.equal((await call('POST', '/api/tv/lookup', { code: 'NOPE-NOPE' }, phone)).status, 404);
  const seen = await call('POST', '/api/tv/lookup', { code: start.body.code }, phone);
  assert.equal(seen.body.name, 'Samsung TV');
  assert.equal(seen.body.username, 'mia');

  const wait = call('POST', '/api/tv/wait', { secret: start.body.secret });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call('POST', '/api/tv/approve', { code: start.body.code }, phone)).status, 200);
  const got = await wait;
  assert.equal(got.body.state, 'approved');
  assert.ok(got.cookie);
  await settle();

  // Roostflix opens; nothing else does.
  const tv = got.cookie;
  const opener = await call('GET', '/api/jellyfin/session', null, tv);
  assert.equal(opener.status, 200);
  assert.ok(opener.body.token, 'the TV has its own Jellyfin sign-in');
  assert.equal(jf.tokens.get(opener.body.token), jf.users.find((u) => u.Name === 'mia').Id);
  assert.equal((await call('GET', '/jellyfin/web/', null, tv)).status, 200);
  assert.equal((await call('GET', '/api/state', null, tv)).body.user, null);
  assert.equal((await call('GET', '/api/apps', null, tv)).status, 401);
  assert.equal((await call('GET', '/api/admin/users', null, tv)).status, 401);
  assert.equal((await call('POST', '/api/tv/approve', { code: 'AAAA-AAAA' }, tv)).status, 401);

  // It shows in My devices, and signing it out ends its Jellyfin sign-in too.
  const devices = (await call('GET', '/api/me/devices', null, phone)).body.devices;
  const entry = devices.find((d) => d.name === 'Roostflix on Samsung TV');
  assert.ok(entry);
  assert.equal(entry.kind, 'tv');
  assert.equal((await call('DELETE', `/api/me/devices/${entry.id}`, null, phone)).status, 200);
  await settle();
  assert.equal(jf.tokens.has(opener.body.token), false);
  assert.equal((await call('GET', '/jellyfin/web/', null, tv)).status, 302);

  // The code was single use.
  assert.equal((await call('POST', '/api/tv/wait', { secret: start.body.secret })).body.state, 'expired');
  const activity = await call('GET', '/api/admin/activity', null, raven);
  assert.ok(JSON.stringify(activity.body).includes('tv-signin'));
});

test('Quick Connect is switched on in Jellyfin when it was off', async () => {
  jf.quick = false;
  const phone = (await call('POST', '/api/login', { username: 'mia', password: 'mia pass 12' })).cookie;
  assert.ok(phone);
  await settle();
  const start = await call('POST', '/api/tv/start', {}, null, TV);
  await call('POST', '/api/tv/approve', { code: start.body.code }, phone);
  const got = await call('POST', '/api/tv/wait', { secret: start.body.secret });
  await settle();
  assert.equal(jf.quick, true);
  assert.ok((await call('GET', '/api/jellyfin/session', null, got.cookie)).body.token);
});

test('a turned-down code signs nothing in', async () => {
  const phone = (await call('POST', '/api/login', { username: 'mia', password: 'mia pass 12' })).cookie;
  const start = await call('POST', '/api/tv/start', {}, null, TV);
  await call('POST', '/api/tv/approve', { code: start.body.code, approve: false }, phone);
  const got = await call('POST', '/api/tv/wait', { secret: start.body.secret });
  assert.equal(got.body.state, 'denied');
  assert.equal(got.cookie, null);
});

test('the TV page and the phone page are served', async () => {
  for (const url of ['/tv', '/code']) {
    const page = await call('GET', url);
    assert.equal(page.status, 200);
    assert.match(String(page.body), /<script src="\/(tv|code)\.js">/);
  }
});
