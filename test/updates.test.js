'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { UpdateChecker, parseRef, MAX_AGE_MS } = require('../src/updates');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

test('image names map to their registry', () => {
  assert.deepEqual(parseRef('nginx'), { host: 'registry-1.docker.io', repo: 'library/nginx', tag: 'latest' });
  assert.deepEqual(parseRef('jellyfin/jellyfin:10.10'), { host: 'registry-1.docker.io', repo: 'jellyfin/jellyfin', tag: '10.10' });
  assert.deepEqual(parseRef('ghcr.io/immich-app/immich-server:release'), { host: 'ghcr.io', repo: 'immich-app/immich-server', tag: 'release' });
  assert.deepEqual(parseRef('localhost:5000/app'), { host: 'localhost:5000', repo: 'app', tag: 'latest' });
  assert.equal(parseRef('nginx@sha256:abc'), null);
  assert.equal(parseRef('sha256:abc'), null);
});

// A fake Docker (images by tag) and a fake registry that wants a token first.
function fakes({ images, remote }) {
  const docker = http.createServer((req, res) => {
    const m = req.url.match(/^\/images\/(.+)\/json$/);
    if (m && images[m[1]]) return res.end(JSON.stringify(images[m[1]]));
    if (req.url === '/images/json') return res.end('[]');
    res.statusCode = 404;
    res.end('{}');
  });
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method || 'GET'} ${u}`);
    if (u.startsWith('https://auth.docker.io/token')) return new Response(JSON.stringify({ token: 't0k' }));
    const repo = u.match(/\/v2\/(.+)\/manifests\//)[1];
    if (!opts.headers.Authorization) {
      return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:${repo}:pull"` } });
    }
    if (!remote[repo]) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { 'docker-content-digest': remote[repo] } });
  };
  return { docker, fetchFn, calls };
}

test('finds updates, pulled-but-not-restarted images, and caches the answer', async () => {
  const images = {
    'jellyfin/jellyfin:latest': { Id: 'sha256:j1', RepoDigests: ['jellyfin/jellyfin@sha256:old'] },
    'nginx:latest': { Id: 'sha256:n1', RepoDigests: ['nginx@sha256:same'] },
    'tailscale/tailscale:latest': { Id: 'sha256:t2', RepoDigests: ['tailscale/tailscale@sha256:x'] },
    'roost-roost': { Id: 'sha256:r1', RepoDigests: [] },
  };
  const remote = { 'jellyfin/jellyfin': 'sha256:new', 'library/nginx': 'sha256:same' };
  const { docker, fetchFn, calls } = fakes({ images, remote });
  await new Promise((r) => docker.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-updates-'));
  let now = Date.parse('2026-10-08T00:00:00Z');
  const checker = new UpdateChecker({ dataDir: dir, dockerHost: `tcp://127.0.0.1:${docker.address().port}`, fetch: fetchFn, now: () => now });
  const containers = [
    { id: 'a', imageRef: 'jellyfin/jellyfin:latest', imageId: 'sha256:j1' },
    { id: 'b', imageRef: 'nginx:latest', imageId: 'sha256:n1' },
    { id: 'b2', imageRef: 'nginx:latest', imageId: 'sha256:n1' },
    { id: 'c', imageRef: 'tailscale/tailscale:latest', imageId: 'sha256:t1' },
    { id: 'd', imageRef: 'roost-roost', imageId: 'sha256:r1' },
  ];
  try {
    // The first look starts a check in the background and shows nothing yet.
    assert.deepEqual(checker.view(containers), {});
    await checker.running;
    const v = checker.view(containers);
    assert.deepEqual(Object.keys(v).sort(), ['a', 'c']);
    assert.equal(v.a.state, 'update');
    assert.equal(v.c.state, 'restart');
    // One HEAD per image (nginx once for two containers); none for the restart or the local build.
    assert.equal(calls.filter((c) => c.startsWith('HEAD')).length, 4);

    // Within 12 hours nothing is asked again, even after a Roost restart.
    const again = new UpdateChecker({ dataDir: dir, dockerHost: checker.dockerHost, fetch: fetchFn, now: () => now });
    calls.length = 0;
    assert.equal(again.view(containers).a.state, 'update');
    assert.equal(again.running, null);
    assert.equal(calls.length, 0);

    // After 12 hours it checks again; a recreated container is checked at once.
    now += MAX_AGE_MS + 1;
    again.view(containers);
    assert.ok(again.running);
    await again.running;

    // Check now: at most once a minute.
    assert.equal(await again.checkNow(containers), true);
    assert.equal(await again.checkNow(containers), false);
  } finally {
    docker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a registry that cannot be reached never shows an update', async () => {
  const images = { 'nginx:latest': { Id: 'sha256:n1', RepoDigests: ['nginx@sha256:a'] } };
  const { docker } = fakes({ images, remote: {} });
  await new Promise((r) => docker.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-updates-'));
  const checker = new UpdateChecker({ dataDir: dir, dockerHost: `tcp://127.0.0.1:${docker.address().port}`, fetch: async () => { throw new Error('offline'); } });
  try {
    checker.view([{ id: 'x', imageRef: 'nginx:latest', imageId: 'sha256:n1' }]);
    await checker.running;
    assert.deepEqual(checker.view([{ id: 'x', imageRef: 'nginx:latest', imageId: 'sha256:n1' }]), {});
  } finally {
    docker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only admins see update badges on the status page', async () => {
  const fake = http.createServer((req, res) => {
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify([{ Id: 'aaa111', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin', State: 'running', Labels: {} }]));
    if (req.url === '/containers/aaa111/json') return res.end(JSON.stringify({ Image: 'sha256:j1', Config: { Image: 'jellyfin/jellyfin:latest' }, State: { Status: 'running', Running: true } }));
    if (req.url === '/images/jellyfin/jellyfin:latest/json') return res.end(JSON.stringify({ Id: 'sha256:j1', RepoDigests: ['jellyfin/jellyfin@sha256:old'] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const { fetchFn } = fakes({ images: {}, remote: { 'jellyfin/jellyfin': 'sha256:new' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-updates-'));
  const server = createServer({ dataDir: dir, probeTimeoutMs: 300, dockerHost: `tcp://127.0.0.1:${fake.address().port}`, registryFetch: fetchFn });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(url + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, admin);
    assert.equal((await call('POST', '/api/admin/updates/check', null, admin)).status, 200);
    const jelly = (await call('GET', '/api/status', null, admin)).body.apps.find((a) => a.id === 'jellyfin');
    assert.equal(jelly.containers[0].update.state, 'update');

    await call('POST', '/api/admin/users', { username: 'mia', password: 'longenough', apps: ['jellyfin'] }, admin);
    const mia = (await call('POST', '/api/login', { username: 'mia', password: 'longenough' })).cookie;
    const seen = (await call('GET', '/api/status', null, mia)).body.apps.find((a) => a.id === 'jellyfin');
    assert.equal(seen.containers[0].update, undefined);
    assert.equal((await call('POST', '/api/admin/updates/check', null, mia)).status, 403);
  } finally {
    server.close();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
