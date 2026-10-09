'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OutsideServices } = require('../src/outside');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

// A fetch that answers per host and counts what it was asked.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(url);
    for (const [host, answer] of Object.entries(answers)) {
      if (url.includes(host)) return typeof answer === 'function' ? answer(url, init) : answer;
    }
    throw new Error('offline');
  };
  fn.calls = calls;
  return fn;
}

const tunnelBox = (over = {}) => ({ name: 'cloudflared', image: 'cloudflare/cloudflared:latest', state: 'running', health: null, restarts: 0, ...over });
const cert = (over = {}) => ({
  state: 'active', domain: 'roostos.network', staging: false, step: '', lastError: null, lastAttemptAt: null,
  certificate: { expiresAt: new Date(Date.now() + 60 * DAY).toISOString(), daysLeft: 60 }, ...over,
});
const byId = (list) => Object.fromEntries(list.map((o) => [o.id, o]));

test('before anything is set up, every line says so and asks for nothing', () => {
  const o = new OutsideServices({ fetchImpl: fakeFetch({}) });
  const v = byId(o.view({ containers: [], cert: { state: 'off', domain: '' } }));
  assert.deepEqual(['cloudflare', 'letsencrypt', 'dockerhub'].map((id) => v[id].state), ['unset', 'unset', 'unset']);
  assert.equal(v.cloudflare.headline, 'Not set up yet');
  assert.equal(v.dockerhub.headline, 'Not checked yet');
});

test('the tunnel line follows its container, with no network use', () => {
  const fetchImpl = fakeFetch({});
  const o = new OutsideServices({ fetchImpl });
  const read = (box) => byId(o.view({ containers: [box], cert: cert() })).cloudflare;
  assert.deepEqual([read(tunnelBox()).state, read(tunnelBox()).headline], ['good', 'Tunnel running']);
  assert.equal(read(tunnelBox({ state: 'exited' })).headline, 'Tunnel stopped');
  assert.equal(read(tunnelBox({ state: 'exited' })).state, 'bad');
  assert.equal(read(tunnelBox({ state: 'restarting' })).headline, 'Tunnel keeps restarting');
  assert.equal(read(tunnelBox({ health: 'unhealthy' })).headline, 'Tunnel unhealthy');
  assert.match(read(tunnelBox({ restarts: 3 })).detail, /3 restarts/);
  // Found by image as well as name.
  assert.equal(read(tunnelBox({ name: 'tunnel-1' })).state, 'good');
  assert.deepEqual(fetchImpl.calls, [], 'reading the page never goes to the internet');
});

test('a domain with no tunnel container is a nudge, and no Docker is just "can’t see"', () => {
  const o = new OutsideServices({ fetchImpl: fakeFetch({}) });
  const none = byId(o.view({ containers: [{ name: 'jellyfin', image: 'jellyfin/jellyfin' }], cert: cert() })).cloudflare;
  assert.equal(none.state, 'watch');
  assert.equal(none.headline, 'No tunnel container found');
  const blind = byId(o.view({ containers: null, cert: cert() })).cloudflare;
  assert.equal(blind.state, 'unset');
  assert.equal(blind.headline, 'Can’t see Docker');
});

test('the certificate line warns quietly under 14 days and names the cause', () => {
  const o = new OutsideServices({ fetchImpl: fakeFetch({}) });
  const at = (daysLeft, extra = {}) => byId(o.view({
    containers: [],
    cert: cert({ certificate: { expiresAt: new Date(Date.now() + daysLeft * DAY).toISOString(), daysLeft }, ...extra }),
  })).letsencrypt;
  const fine = at(60);
  assert.deepEqual([fine.state, fine.headline], ['good', 'Certificate valid']);
  assert.ok(fine.expiresAt);
  // Renewal starts at 30 days left, so 20 is still fine.
  assert.equal(at(20).state, 'good');
  const low = at(9);
  assert.deepEqual([low.state, low.headline], ['watch', 'Runs out in 9 days']);
  const failing = at(9, { state: 'warning', lastError: 'Cloudflare refused the token' });
  assert.match(failing.detail, /Renewing isn’t working: Cloudflare refused the token/);
  assert.equal(at(1).headline, 'Runs out in 1 day');
  const gone = at(-2);
  assert.deepEqual([gone.state, gone.headline], ['bad', 'Expired']);
  const none = byId(o.view({ containers: [], cert: { state: 'error', domain: 'roostos.network', certificate: null, lastError: 'DNS never showed the record' } })).letsencrypt;
  assert.deepEqual([none.state, none.headline, none.detail], ['bad', 'No certificate', 'DNS never showed the record']);
  assert.equal(byId(o.view({ containers: [], cert: cert({ state: 'working', step: 'Waiting for DNS' }) })).letsencrypt.detail, 'Waiting for DNS');
  assert.match(at(60, { staging: true }).detail, /Test certificate/);
});

test('Docker Hub: reachable, answering badly, or unreachable', async () => {
  const check = (answer) => new OutsideServices({ fetchImpl: fakeFetch({ 'docker.io': answer }) }).checkDockerHub();
  // Docker Hub answers an anonymous hello with 401, which still proves it is up.
  assert.equal((await check(json(401, {}))).ok, true);
  assert.equal((await check(json(200, {}))).ok, true);
  const bad = await check(json(503, {}));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /503/);
  const down = await check(() => { throw new Error('ENOTFOUND'); });
  assert.deepEqual([down.ok, down.detail], [false, 'Roost couldn’t reach Docker Hub']);

  const o = new OutsideServices({ fetchImpl: fakeFetch({ 'docker.io': json(401, {}) }) });
  await o.check();
  const line = byId(o.view({ containers: [], cert: { state: 'off' } })).dockerhub;
  assert.deepEqual([line.state, line.headline], ['good', 'Reachable']);
  assert.ok(line.checkedAt);
  const missed = new OutsideServices({ fetchImpl: fakeFetch({}) });
  await missed.check();
  const nudge = byId(missed.view({ containers: [], cert: { state: 'off' } })).dockerhub;
  // A miss only matters for installs and updates, so it is a nudge, not red.
  assert.deepEqual([nudge.state, nudge.headline], ['watch', 'Can’t reach it']);
  assert.match(nudge.detail, /Running apps keep working/);
});

test('the saved Cloudflare token is checked, never shown, and only when there is one', async () => {
  const seen = [];
  const fetchImpl = fakeFetch({
    'api.cloudflare.com': (url, init) => { seen.push(init.headers.Authorization); return json(200, { success: true, result: { status: 'active' } }); },
    'docker.io': json(401, {}),
  });
  const o = new OutsideServices({ fetchImpl, tokenOf: () => 'secret-token' });
  await o.check();
  assert.deepEqual(seen, ['Bearer secret-token']);
  const good = byId(o.view({ containers: [tunnelBox()], cert: cert() })).cloudflare;
  assert.match(good.detail, /Saved token works/);
  assert.ok(!JSON.stringify(o.view({ containers: [tunnelBox()], cert: cert() })).includes('secret-token'));

  const noToken = new OutsideServices({ fetchImpl: fakeFetch({ 'docker.io': json(401, {}) }) });
  await noToken.check();
  assert.equal(noToken.checks.cloudflare, null);

  const refused = new OutsideServices({
    fetchImpl: fakeFetch({ 'api.cloudflare.com': json(401, { success: false }), 'docker.io': json(401, {}) }),
    tokenOf: () => 'old',
  });
  await refused.check();
  const line = byId(refused.view({ containers: [tunnelBox()], cert: cert() })).cloudflare;
  assert.deepEqual([line.state, line.headline], ['watch', 'Token needs attention']);
  assert.match(line.detail, /no longer accepts the saved token/);
  // Being offline is Docker Hub's story, not a reason to say the token is bad.
  const offline = new OutsideServices({ fetchImpl: fakeFetch({}), tokenOf: () => 'tok' });
  await offline.check();
  assert.equal(byId(offline.view({ containers: [tunnelBox()], cert: cert() })).cloudflare.state, 'good');
  refused.forgetCloudflare();
  assert.equal(refused.checks.cloudflare, null);
});

test('slow checks run once at a time and then daily, not on every page load', async () => {
  let n = 0;
  const fetchImpl = fakeFetch({ 'docker.io': async () => { n++; await new Promise((r) => setTimeout(r, 20)); return json(401, {}); } });
  const o = new OutsideServices({ fetchImpl, firstCheckMs: 10 });
  o.check();
  o.check();
  o.check();
  await o.busy;
  assert.equal(n, 1, 'overlapping checks share one round');
  o.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(n, 2, 'the first scheduled check runs soon after start');
  o.stop();
});

let server;
let base;
let dir;
after(() => {
  if (server) server.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the status page gives the list to admins only', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-outside-'));
  server = createServer({ dataDir: dir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', outsideOptions: { fetchImpl: fakeFetch({}) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: set && set.split(';')[0] };
  };
  const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  const made = await call('POST', '/api/admin/users', { username: 'mia', password: 'another long one', role: 'user' }, admin);
  assert.equal(made.status, 201);
  const mia = (await call('POST', '/api/login', { username: 'mia', password: 'another long one' })).cookie;

  const seen = await call('GET', '/api/status', null, admin);
  assert.deepEqual(seen.body.outside.map((o) => o.id), ['cloudflare', 'letsencrypt', 'dockerhub']);
  // Docker isn't reachable here, so the tunnel line says it can't see.
  assert.equal(seen.body.outside[0].headline, 'Can’t see Docker');
  assert.equal((await call('GET', '/api/status', null, mia)).body.outside, null);
});
