'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { suggestions, templates, imageName } = require('../src/templates');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

test('image names lose their registry and tag', () => {
  assert.equal(imageName('lscr.io/linuxserver/jellyfin:10.9'), 'linuxserver/jellyfin');
  assert.equal(imageName('ghcr.io/home-assistant/home-assistant:stable'), 'home-assistant/home-assistant');
  assert.equal(imageName('jellyfin/jellyfin'), 'jellyfin/jellyfin');
  assert.equal(imageName('localhost:5000/deluan/navidrome:latest'), 'deluan/navidrome');
  assert.equal(imageName('library/nginx@sha256:abc'), 'nginx');
});

const running = (name, image, ports = [], project = '') => ({ id: name, name, image, project, state: 'running', ports });

test('running containers without a card become suggestions with their real port', () => {
  const apps = [{ id: 'jellyfin', name: 'Jellyfin', container: '' }];
  const list = suggestions(apps, [
    running('jellyfin', 'jellyfin/jellyfin', [{ public: 8096, private: 8096 }]),
    running('roost', 'roost', [{ public: 8080, private: 8080 }]),
    running('ha', 'ghcr.io/home-assistant/home-assistant:stable', [{ public: 80, private: 8000 }, { public: 18123, private: 8123 }]),
    running('music-box', 'my/thing', [{ public: 3000, private: 3000 }]),
    running('immich_postgres', 'postgres:16'),
    { ...running('old', 'deluan/navidrome', [{ public: 4533, private: 4533 }]), state: 'exited' },
  ], 'roost');
  assert.deepEqual(list.map((s) => [s.name, s.url, s.container, s.icon]), [
    ['Home Assistant', 'http://{host}:18123', 'ha', 'home'],
    ['Music Box', 'http://{host}:3000', 'music-box', 'grid'],
  ]);
});

test('a container on host networking uses the template port', () => {
  const [s] = suggestions([], [running('portainer', 'portainer/portainer-ce:2.21')], 'roost');
  assert.equal(s.url, 'https://{host}:9443');
});

test('templates include Roost apps with their ids and others without', () => {
  const byKey = Object.fromEntries(templates().map((t) => [t.key, t]));
  assert.equal(byKey.jellyfin.id, 'jellyfin');
  assert.equal(byKey.jellyfin.url, 'http://{host}:8096');
  assert.equal(byKey.nest.url, '#/nest');
  assert.equal(byKey.navidrome.id, undefined);
  assert.equal(byKey.navidrome.url, 'http://{host}:4533');
});

test('admins get templates and running containers; others are refused', async () => {
  const fake = http.createServer((req, res) => {
    if (req.url.startsWith('/containers/json')) {
      return res.end(JSON.stringify([
        { Id: 'aaa111', Names: ['/navidrome'], Image: 'deluan/navidrome:latest', State: 'running', Labels: {},
          Ports: [{ IP: '0.0.0.0', PrivatePort: 4533, PublicPort: 4600, Type: 'tcp' }, { IP: '::', PrivatePort: 4533, PublicPort: 4600, Type: 'tcp' }] },
      ]));
    }
    res.end(JSON.stringify({ State: { Status: 'running', Running: true } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-templates-'));
  const s = createServer({ dataDir: dir, probeTimeoutMs: 300, dockerHost: `tcp://127.0.0.1:${fake.address().port}` });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('roost_session=') && c !== 'roost_session=');
    return { status: res.status, body: await res.json().catch(() => null), cookie: set };
  };
  try {
    assert.equal((await call('GET', '/api/admin/app-templates')).status, 401);
    const { cookie } = await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' });
    await setUpTwoStep(call, cookie);
    const { status, body } = await call('GET', '/api/admin/app-templates', null, cookie);
    assert.equal(status, 200);
    assert.equal(body.docker.ok, true);
    assert.deepEqual(body.running.map((a) => [a.name, a.url, a.container]), [['Navidrome', 'http://{host}:4600', 'navidrome']]);
    assert.ok(body.templates.some((t) => t.key === 'jellyfin'));
  } finally {
    s.closeAllConnections();
    s.close();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
