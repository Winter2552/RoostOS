'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Watcher, GRACE_MS } = require('../src/alerts');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const GB = 1024 ** 3;

function setup({ containers = [], disks = [], settings = {} } = {}) {
  const env = {
    clock: Date.parse('2026-10-07T12:00:00Z'),
    docker: { containers },
    disks,
    saves: 0,
    events: [],
  };
  let n = 0;
  const store = {
    db: { settings: { serverName: 'Roost', ...settings }, apps: [{ id: 'jellyfin', name: 'Jellyfin' }, { id: 'nest', name: 'Nest' }], users: [] },
    save: () => { env.saves++; },
  };
  env.store = store;
  env.watcher = new Watcher({
    store,
    readContainers: async () => env.docker,
    readDisks: () => env.disks,
    onChange: (event, alert) => env.events.push([event, alert.title]),
    now: () => env.clock,
    newId: () => `a${++n}`,
  });
  env.tick = async (ms = 60 * 1000) => { env.clock += ms; await env.watcher.check(); };
  return env;
}

const jelly = (over = {}) => ({ id: 'c1', name: 'jellyfin', project: '', state: 'running', health: null, restarts: 0, exitCode: null, ...over });

test('a stopped app alerts only after the grace period, then clears', async () => {
  const env = setup({ containers: [jelly()] });
  await env.watcher.check();
  assert.equal(env.saves, 0, 'a quiet check writes nothing');

  env.docker = { containers: [jelly({ state: 'exited', exitCode: 137 })] };
  await env.tick();
  assert.equal(env.store.db.alerts.length, 0, 'still inside the grace period');
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, [['raised', 'Jellyfin has stopped']]);
  const [alert] = env.store.db.alerts;
  assert.equal(alert.detail, 'jellyfin · exit code 137');
  assert.equal(alert.resolvedAt, null);

  const saves = env.saves;
  await env.tick();
  assert.equal(env.saves, saves, 'an unchanged alert is not saved again');
  assert.equal(env.events.length, 1, 'and not raised again');

  env.docker = { containers: [jelly()] };
  await env.tick();
  assert.deepEqual(env.events[1], ['resolved', 'Jellyfin has stopped']);
  assert.ok(env.store.db.alerts[0].resolvedAt);
});

test('a quick restart never alerts', async () => {
  const env = setup({ containers: [jelly()] });
  await env.watcher.check();
  env.docker = { containers: [jelly({ state: 'exited' })] };
  await env.tick();
  env.docker = { containers: [jelly()] };
  await env.tick();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, []);
});

test('unhealthy and crash-looping containers alert', async () => {
  const env = setup({ containers: [jelly({ health: 'unhealthy' })] });
  await env.watcher.check();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, [['raised', 'Jellyfin is unhealthy']]);
  env.docker = { containers: [jelly({ state: 'restarting', restarts: 4 })] };
  await env.tick();
  // Same app, so the open alert is updated in place rather than a new one raised.
  assert.equal(env.store.db.alerts.length, 1);
  assert.equal(env.store.db.alerts[0].title, 'Jellyfin keeps restarting');
});

test('a container Docker restarted between checks leaves a note', async () => {
  const env = setup({ containers: [jelly({ restarts: 1 })] });
  await env.watcher.check();
  env.docker = { containers: [jelly({ restarts: 2 })] };
  await env.tick();
  assert.deepEqual(env.events, [['event', 'Jellyfin restarted on its own']]);
  const [note] = env.store.db.alerts;
  assert.equal(note.startedAt, note.resolvedAt);
});

test('apps with no container and paused containers are left alone', async () => {
  const env = setup({ containers: [jelly({ state: 'paused' })] });
  await env.watcher.check();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, []);
});

test('Docker going away alerts once, unless Docker was never set up', async () => {
  const env = setup();
  env.docker = { error: 'not configured' };
  await env.watcher.check();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, []);
  env.docker = { error: 'connect ECONNREFUSED' };
  await env.tick();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, [['raised', "Roost can't reach Docker"]]);
});

test('a full drive alerts at once and clears a little below the line', async () => {
  const disk = (usedPct) => ({ label: 'Data', path: '/hostfs/data', total: 100 * GB, free: (100 - usedPct) * GB });
  const env = setup({ disks: [disk(89)] });
  await env.watcher.check();
  assert.deepEqual(env.events, []);
  env.disks = [disk(91)];
  await env.tick();
  assert.deepEqual(env.events, [['raised', 'Data drive is 91% full']]);
  env.disks = [disk(89)];
  await env.tick();
  assert.equal(env.events.length, 1, 'still above the 87% clear line');
  assert.equal(env.store.db.alerts[0].title, 'Data drive is 89% full');
  env.disks = [disk(86)];
  await env.tick();
  assert.deepEqual(env.events[1], ['resolved', 'Data drive is 89% full']);
});

test('settings turn checks off and move the drive level', async () => {
  const disk = { label: 'Data', path: '/d', total: 100 * GB, free: 15 * GB };
  const env = setup({ disks: [disk], containers: [jelly({ state: 'exited' })], settings: { alertDiskPct: 80, alertApps: false } });
  let dockerCalls = 0;
  env.watcher.readContainers = async () => { dockerCalls++; return env.docker; };
  await env.watcher.check();
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, [['raised', 'Data drive is 85% full']]);
  assert.equal(dockerCalls, 0, 'Docker is not asked when app alerts are off');
  env.store.db.settings.alertDisks = false;
  await env.tick();
  assert.deepEqual(env.events[1], ['resolved', 'Data drive is 85% full']);
});

test('a missing drive waits out the grace period', async () => {
  const env = setup({ disks: [{ label: 'Data', path: '/d', missing: true }] });
  await env.watcher.check();
  assert.deepEqual(env.events, []);
  await env.tick(GRACE_MS);
  assert.deepEqual(env.events, [['raised', 'Data drive not found']]);
});

test('cleared alerts are kept for a week', async () => {
  const env = setup({ containers: [jelly({ restarts: 0 })] });
  await env.watcher.check();
  env.docker = { containers: [jelly({ restarts: 1 })] };
  await env.tick();
  assert.equal(env.store.db.alerts.length, 1);
  await env.tick(8 * 24 * 60 * 60 * 1000);
  assert.equal(env.store.db.alerts.length, 0);
});

test('alerts: admins read, ignore and tune them; users cannot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-alerts-'));
  const docker = { containers: [{ id: 'c1', name: 'jellyfin', project: '', state: 'exited', health: null, restarts: 0, exitCode: 1 }] };
  const server = createServer({ dataDir: dir, alertIntervalMs: 0, disks: [{ label: 'Data', path: dir }], readContainers: async () => docker });
  let clock = Date.now();
  server.watcher.now = () => clock;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(url + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, admin);
    await call('POST', '/api/admin/users', { username: 'sam', password: 'correct horse' }, admin);
    const sam = (await call('POST', '/api/login', { username: 'sam', password: 'correct horse' })).cookie;
    assert.equal((await call('GET', '/api/alerts', null, sam)).status, 403);

    await server.watcher.check();
    clock += 3 * 60 * 1000;
    await server.watcher.check();
    let view = (await call('GET', '/api/alerts', null, admin)).body;
    assert.deepEqual(view.active.map((a) => a.title), ['Jellyfin has stopped']);
    assert.deepEqual(view.settings, { alertApps: true, alertDisks: true, alertDiskPct: 90 });
    assert.ok(view.checkedAt);

    assert.equal((await call('POST', `/api/alerts/${view.active[0].id}/dismiss`, null, sam)).status, 403);
    view = (await call('POST', `/api/alerts/${view.active[0].id}/dismiss`, null, admin)).body;
    assert.ok(view.active[0].dismissedAt);

    assert.equal((await call('PATCH', '/api/admin/settings', { alertDiskPct: 101 }, admin)).status, 400);
    const saved = await call('PATCH', '/api/admin/settings', { alertApps: false, alertDisks: false, alertDiskPct: 80 }, admin);
    assert.equal(saved.status, 200);
    // Turning the checks off re-checks at once, so the app alert clears.
    view = (await call('GET', '/api/alerts', null, admin)).body;
    assert.deepEqual(view.settings, { alertApps: false, alertDisks: false, alertDiskPct: 80 });
    assert.deepEqual(view.active, []);
    assert.deepEqual(view.recent.map((a) => a.title), ['Jellyfin has stopped']);
    assert.equal((await call('POST', `/api/alerts/${view.recent[0].id}/dismiss`, null, admin)).status, 404);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
