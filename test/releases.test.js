'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createServer } = require('../src/server');
const { load, problems, compareVersions, unseenFor, visibleTo } = require('../src/releases');

const dir = path.join(__dirname, '..', 'releases');

test('every release file is complete and its pictures exist and are small', () => {
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const rel = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const bad = problems(rel, dir, { draft: name === 'next.json' });
    assert.deepStrictEqual(bad, [], `releases/${name}: ${bad.join('; ')}`);
    if (name !== 'next.json') assert.strictEqual(`${rel.version}.json`, name, `${name} holds version ${rel.version}`);
  }
});

test('the newest release matches package.json', () => {
  const [newest] = load(dir);
  const pkg = require('../package.json');
  assert.strictEqual(pkg.version.replace(/\.0$/, ''), newest.version.replace(/\.0$/, ''));
});

test('versions compare part by part', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('0.2', '0.1.9') > 0);
  assert.strictEqual(compareVersions('0.1', '0.1.0'), 0);
});

test('people see what they have not seen, minus admin-only items', () => {
  const releases = [
    { version: '0.2', date: '2026-10-20', title: 'B', items: [{ title: 'x', text: 'x', image: 'x.png', admin: true }] },
    { version: '0.1', date: '2026-10-16', title: 'A', items: [{ title: 'y', text: 'y', image: 'y.png' }] },
  ];
  assert.deepStrictEqual(visibleTo(releases, 'user').map((r) => r.version), ['0.1']);
  assert.deepStrictEqual(unseenFor(releases, { role: 'admin', createdAt: '2026-10-01T00:00:00Z' }), ['0.2', '0.1']);
  assert.deepStrictEqual(unseenFor(releases, { role: 'admin', createdAt: '2026-10-01T00:00:00Z', seenVersion: '0.1' }), ['0.2']);
  // A new account is not shown releases from before it existed.
  assert.deepStrictEqual(unseenFor(releases, { role: 'admin', createdAt: '2026-10-18T00:00:00Z' }), ['0.2']);
});

test('the server lists releases, shows them once, and remembers they were seen', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-releases-'));
  const server = createServer({ dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const headers = cookie ? { Cookie: cookie } : {};
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: set && set.split(';')[0], res };
  };
  try {
    assert.equal((await call('GET', '/api/releases')).status, 401);
    const made = await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' });
    const cookie = made.cookie;
    // An account made today is not shown releases from before today.
    const state = await call('GET', '/api/state', null, cookie);
    assert.equal(state.body.version, load(dir)[0].version);
    const list = await call('GET', '/api/releases', null, cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.releases[0].version, state.body.version);
    const img = await fetch(`${base}/releases/img/${list.body.releases[0].items[0].image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/releases/img/..%2Fnext.json`)).status, 404);
    // An older account sees the release once, then not again.
    assert.ok(Array.isArray(state.body.user.whatsNew));
    const seen = await call('POST', '/api/me/whats-new/seen', null, cookie);
    assert.deepStrictEqual(seen.body.user.whatsNew, []);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
