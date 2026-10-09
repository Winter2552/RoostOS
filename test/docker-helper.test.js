'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createHelper, parseNames } = require('../src/docker-helper');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

// A stand-in for the Docker socket that records what reached it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-helper-'));
const socketPath = path.join(dir, 'docker.sock');
const seen = [];
const containers = [
  { Id: 'aaa111', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin', State: 'running', Labels: {} },
  { Id: 'ccc333', Names: ['/roost'], Image: 'roost', State: 'running', Labels: {} },
  { Id: 'ddd444', Names: ['/nova-app'], Image: 'nova', State: 'running', Labels: {} },
];
const docker = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify(containers));
  if (req.url.startsWith('/events')) return res.end('{"Type":"container"}\n');
  if (/^\/containers\/\w+\/json$/.test(req.url)) {
    return res.end(JSON.stringify({ State: { Status: 'running', Running: true }, RestartCount: 1, Config: { Env: ['SECRET=hunter2'] }, HostConfig: {} }));
  }
  if (req.method === 'POST' && req.url.includes('/restart')) {
    res.statusCode = 204;
    return res.end();
  }
  res.end('{}');
});

let helper;
let helperUrl;

before(async () => {
  await new Promise((r) => docker.listen(socketPath, r));
  helper = createHelper({ socketPath, restartable: parseNames('jellyfin, roost, bad/name') });
  await new Promise((r) => helper.listen(0, '127.0.0.1', r));
  helperUrl = `http://127.0.0.1:${helper.address().port}`;
});

after(() => {
  helper.close();
  docker.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ask = (method, url) => fetch(helperUrl + url, { method }).then((r) => r.status);

test('the helper passes on reading containers and listed restarts', async () => {
  seen.length = 0;
  assert.equal(await ask('GET', '/containers/json?all=1'), 200);
  assert.equal(await ask('GET', '/v1.43/containers/jellyfin/json'), 200);
  assert.equal(await ask('POST', '/containers/jellyfin/restart?t=0&signal=KILL'), 204);
  // Docker always gets a clean request, whatever the caller added.
  assert.deepEqual(seen, ['GET /containers/json?all=1', 'GET /containers/jellyfin/json', 'POST /containers/jellyfin/restart?t=10']);
  const list = await (await fetch(`${helperUrl}/roost/restartable`)).json();
  assert.deepEqual(list.names, ['jellyfin', 'roost']);
});

test('the helper hides everything but state from container details', async () => {
  const info = await (await fetch(`${helperUrl}/containers/jellyfin/json`)).json();
  assert.deepEqual(Object.keys(info).sort(), ['RestartCount', 'State']);
});

test('the helper passes on only the fixed container-events stream', async () => {
  seen.length = 0;
  const res = await fetch(`${helperUrl}/events?since=0&filters=${encodeURIComponent('{"type":["image"]}')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /container/);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith('GET /events?filters='));
  assert.ok(decodeURIComponent(seen[0]).includes('{"type":["container"]}'));
  assert.ok(!seen[0].includes('since'));
});

test('the helper refuses everything else', async () => {
  seen.length = 0;
  for (const [method, url] of [
    ['POST', '/containers/nova-app/restart'],
    ['POST', '/containers/jellyfin/stop'],
    ['POST', '/containers/jellyfin/start'],
    ['POST', '/containers/jellyfin/kill'],
    ['DELETE', '/containers/jellyfin'],
    ['POST', '/containers/create'],
    ['POST', '/containers/jellyfin/exec'],
    ['GET', '/containers/jellyfin/logs'],
    ['GET', '/containers/jellyfin/archive?path=/etc'],
    ['GET', '/images/json'],
    ['GET', '/containers/..%2Fimages/json'],
    ['POST', '/containers/jellyfin%2F..%2Fnova-app/restart'],
    ['POST', '/roost/restartable'],
  ]) {
    assert.equal(await ask(method, url), 403, `${method} ${url}`);
  }
  assert.deepEqual(seen, []);
});

test('admins restart an app through the helper; Roost itself is never offered', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-restart-'));
  const server = createServer({ dataDir, probeTimeoutMs: 300, dockerHost: `tcp://127.0.0.1:${helper.address().port}` });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
  };
  try {
    const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, admin);
    await call('POST', '/api/admin/users', { username: 'mia', password: 'correct horse', role: 'user' }, admin);
    const mia = (await call('POST', '/api/login', { username: 'mia', password: 'correct horse' })).cookie;

    const status = (await call('GET', '/api/status', null, admin)).body;
    const byId = Object.fromEntries(status.apps.map((a) => [a.id, a]));
    assert.equal(byId.jellyfin.restartable, true);
    assert.equal(byId.nova.restartable, false); // not on the helper's list
    assert.equal(byId.roost.restartable, undefined);
    const miaStatus = (await call('GET', '/api/status', null, mia)).body;
    assert.ok(miaStatus.apps.every((a) => !a.restartable));

    seen.length = 0;
    assert.equal((await call('POST', '/api/admin/apps/jellyfin/restart', null, mia)).status, 403);
    assert.equal((await call('POST', '/api/admin/apps/nova/restart', null, admin)).status, 403);
    assert.equal((await call('POST', '/api/admin/apps/nope/restart', null, admin)).status, 404);
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 0);

    assert.equal((await call('POST', '/api/admin/apps/jellyfin/restart', null, admin)).status, 200);
    assert.deepEqual(seen.filter((s) => s.startsWith('POST')), ['POST /containers/jellyfin/restart?t=10']);
    // A second tap straight after is turned away.
    assert.equal((await call('POST', '/api/admin/apps/jellyfin/restart', null, admin)).status, 429);

    const log = (await call('GET', '/api/admin/activity?filter=apps', null, admin)).body.entries;
    assert.equal(log[0].type, 'app-restarted');
    assert.equal(log[0].actor, 'raven');
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an app restarts itself on its schedule, and only when it can be restarted', async () => {
  const { clockIn } = require('../src/schedule');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-schedule-'));
  const server = createServer({
    dataDir, probeTimeoutMs: 300, scheduleCheckMs: 50, dockerHost: `tcp://127.0.0.1:${helper.address().port}`,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
  };
  try {
    const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, admin);
    const apps = (await call('GET', '/api/apps', null, admin)).body.apps;
    const put = (jellyfin, nova) => call('PUT', '/api/admin/apps', {
      apps: apps.map((a) => (a.id === 'jellyfin' ? { ...a, restartSchedule: jellyfin } : a.id === 'nova' ? { ...a, restartSchedule: nova } : a)),
    }, admin);

    // Not on the helper's list: refused when saving, not left to fail every night.
    const never = { every: 'day', time: '04:00', tz: 'UTC' };
    assert.equal((await put(null, never)).status, 400);
    assert.equal((await put({ every: 'day', time: 'soon', tz: 'UTC' }, null)).status, 400);

    // Wait out the end of a minute so "now" is still the same minute when it fires.
    if (new Date().getUTCSeconds() > 55) await new Promise((r) => setTimeout(r, 5000));
    seen.length = 0;
    const now = clockIn(new Date(), 'UTC');
    assert.equal((await put({ every: 'day', time: now.time, tz: 'UTC' }, null)).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    // Once in that minute, however often it checks.
    assert.deepEqual(seen.filter((s) => s.startsWith('POST')), ['POST /containers/jellyfin/restart?t=10']);
    const log = (await call('GET', '/api/admin/activity?filter=apps', null, admin)).body.entries;
    assert.equal(log[0].type, 'app-restarted');
    assert.equal(log[0].actor, 'schedule');

    // It shows on the admin's status card.
    const status = (await call('GET', '/api/status', null, admin)).body;
    assert.equal(status.apps.find((a) => a.id === 'jellyfin').restartSchedule.time, now.time);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
