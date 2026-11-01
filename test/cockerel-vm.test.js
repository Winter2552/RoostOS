'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../cockerel-vm/lib');
const { Cockerel } = require('../src/cockerel');

test('the VM and Roost sign the same way', () => {
  const secret = 'x'.repeat(30);
  const store = { db: { settings: { cockerel: { url: 'http://10.0.0.2:7070', secret } } }, save() {} };
  const roost = new Cockerel({ store, newId: () => '1' });
  const body = '{"a":1}';
  assert.equal(roost.verify(lib.headers(secret, body), body), true, 'VM to Roost');
  assert.equal(lib.verify(secret, roost.headers(body), body), true, 'Roost to VM');
  assert.equal(lib.verify(secret, lib.headers(secret, body, Date.now() - 600000), body), false, 'stale');
  assert.equal(lib.verify('other-secret-other-secret-xx', lib.headers(secret, body), body), false);
});

test('open sources need no question; everything else does; local is never allowed', () => {
  assert.equal(lib.sourceKind('https://archive.org/download/Sintel/Sintel.mp4'), 'open');
  assert.equal(lib.sourceKind('https://ia800123.us.archive.org/x/y.mp4'), 'open');
  assert.equal(lib.sourceKind('https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov'), 'open');
  assert.equal(lib.sourceKind('https://evilarchive.org/a.mp4'), 'other', 'lookalike host');
  assert.equal(lib.sourceKind('https://archive.org.evil.com/a.mp4'), 'other');
  assert.equal(lib.sourceKind('https://example.com/film.mkv'), 'other');
  assert.equal(lib.sourceKind('magnet:?xt=urn:btih:abc'), 'other');
  for (const bad of ['http://archive.org/a.mp4', 'https://192.168.4.35/a', 'https://localhost/a', 'https://nas.local/a', 'file:///etc/passwd', 'https://user:pw@archive.org/a', 'nonsense', '']) {
    assert.equal(lib.sourceKind(bad), 'bad', bad);
  }
});

test('files are named the way Jellyfin likes', () => {
  assert.equal(lib.moviePath('/srv/media', 'Sintel', 2010, '.mkv'), '/srv/media/Movies/Sintel (2010)/Sintel (2010).mkv');
  assert.equal(lib.moviePath('/m', 'What/If?: Part 1', '', '.mp4'), '/m/Movies/What If Part 1/What If Part 1.mp4');
  assert.equal(lib.moviePath('/m', '../../etc', 2000, '.mkv'), '/m/Movies/etc (2000)/etc (2000).mkv', 'no climbing out');
  assert.throws(() => lib.moviePath('/m', '  ', 2000, '.mkv'));
  assert.equal(lib.episodePath('/m', 'Pioneers', 'pioneers.s01e02.720p.mkv'), '/m/Series/Pioneers/Season 01/Pioneers - S01E02.mkv');
  assert.equal(lib.episodePath('/m', 'Pioneers', 'extras.mkv'), null);
});

test('job ids stay plain', () => {
  assert.equal(lib.jobIdOk('j-123_a'), true);
  for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(41)]) assert.equal(lib.jobIdOk(bad), false);
});

// ---------- the service itself, with a pretend Claude ----------
test('the service answers only signed requests and runs Claude for chat', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockerel-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cockerel-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho \'{"result":"Hello Raven"}\'\n', { mode: 0o755 });
  const secret = 'service-test-secret-0123456789';
  process.env.COCKEREL_HOME = home;
  process.env.COCKEREL_SECRET = secret;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.MAX_RUNS_PER_DAY = '2';
  const { server } = require('../cockerel-vm/service');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (method, url, payload, sign = true) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return fetch(base + url, { method, headers: sign ? lib.headers(secret, body) : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : body }).then(async (r) => ({ status: r.status, body: await r.json() }));
  };
  try {
    assert.equal((await ask('GET', '/status', undefined, false)).status, 401);
    const st = await ask('GET', '/status');
    assert.equal(st.status, 200);
    assert.ok(['up', 'down'].includes(st.body.vpn));
    assert.equal((await ask('POST', '/chat', { text: 'hi' })).body.reply, 'Hello Raven');
    assert.equal((await ask('POST', '/chat', { text: 'again' })).body.reply, 'Hello Raven');
    assert.match((await ask('POST', '/chat', { text: 'third' })).body.reply, /used my 2 runs/, 'daily cap');
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- the helper tool, with pretend Roost, ffprobe and aria2 ----------
test('the tool files a finished download, and asks before an unusual source or a big file', async () => {
  const fs = require('fs');
  const http = require('http');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const secret = 'tool-test-secret-0123456789ab';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockerel-tool-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ffprobe'), '#!/bin/sh\necho 5400\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'aria2c'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen = [];
  const roost = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    assert.ok(lib.verify(secret, req.headers, body), 'every call to Roost is signed');
    const msg = JSON.parse(body);
    seen.push(msg);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(msg.type === 'check' ? { decision: msg.bytes > 5e9 ? 'ask' : 'auto', reason: 'over the 5 GB limit for one download' } : { ok: true }));
  });
  await new Promise((r) => roost.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, COCKEREL_HOME: path.join(root, 'home'), MEDIA_ROOT: path.join(root, 'media'),
    INCOMING_DIR: path.join(root, 'media', 'incoming'), ROOST_URL: `http://127.0.0.1:${roost.address().port}`, COCKEREL_SECRET: secret,
  };
  // spawnSync would freeze the pretend Roost, so run the tool asynchronously.
  const tool = (...args) => new Promise((resolve) => {
    const child = require('child_process').spawn('node', [path.join(__dirname, '..', 'cockerel-vm', 'tool.js'), ...args], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  try {
    // 1. A web link on a source he doesn't normally use: he asks first and starts nothing.
    let r = await tool('fetch', 'https://example.com/film.mkv', '--job', 'j1', '--name', 'Home Movie', '--year', '2020');
    assert.equal(r.code, 0);
    assert.match(r.out, /entitled/);
    assert.equal(seen.find((m) => m.type === 'ask').askId, 'entitled-j1');
    assert.ok(!seen.some((m) => m.type === 'spend'));
    // 2. A link that must never be fetched.
    r = await tool('fetch', 'https://192.168.4.35/secret', '--job', 'j2', '--name', 'X');
    assert.notEqual(r.code, 0);
    // 3. A finished download is checked, named for Jellyfin, moved, and the requester told.
    fs.mkdirSync(path.join(env.INCOMING_DIR, 'j3', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(env.INCOMING_DIR, 'j3', 'sub', 'sintel.mkv'), 'x'.repeat(2000));
    fs.writeFileSync(path.join(env.INCOMING_DIR, 'j3', 'readme.txt'), 'hi');
    fs.mkdirSync(path.join(env.COCKEREL_HOME, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(env.COCKEREL_HOME, 'state', 'jobs', 'j3.json'), JSON.stringify({ id: 'j3', name: 'Sintel', year: '2010', kind: 'movie', requester: 'sam', status: 'downloading' }));
    seen.length = 0;
    r = await tool('done', 'j3');
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(env.MEDIA_ROOT, 'Movies', 'Sintel (2010)', 'Sintel (2010).mkv')));
    assert.ok(!fs.existsSync(path.join(env.INCOMING_DIR, 'j3')), 'leftovers removed');
    assert.deepEqual(seen.map((m) => m.type), ['refresh', 'job', 'log', 'ready']);
    assert.equal(seen.find((m) => m.type === 'ready').requester, 'sam');
    seen.length = 0;
    await tool('done', 'j3');
    assert.equal(seen.length, 0, 'finishing twice does nothing');
  } finally {
    roost.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research runs read the web but cannot download; film runs cannot browse', () => {
  const { modeFor, allowedFor } = require('../cockerel-vm/service');
  assert.equal(modeFor('Find Sintel and add it to Roostflix'), 'media');
  assert.equal(modeFor('Show me the best way to season a pan'), 'assistant');
  const research = allowedFor('assistant');
  assert.ok(research.includes('WebSearch') && research.includes('WebFetch'));
  assert.ok(!research.some((t) => /fetch:|find:/.test(t) && t.startsWith('Bash')), 'no downloads in research');
  assert.ok(research.includes('Bash(cockerel-tool send:*)'));
  const film = allowedFor('media');
  assert.ok(film.includes('Bash(cockerel-tool fetch:*)') && !film.includes('WebFetch'));
  for (const t of [...research, ...film]) assert.notEqual(t, 'Read', 'no file reading');
});

test('he only browses real https websites and gets plain text back', () => {
  assert.equal(lib.browseUrl('https://www.wickes.co.uk/p/x'), 'https://www.wickes.co.uk/p/x');
  for (const bad of ['http://example.com', 'https://192.168.4.35/', 'https://localhost/', 'https://nas.local/', 'https://u:p@example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) assert.equal(lib.browseUrl(bad), null, bad);
  const text = lib.pageText('<html><head><title>x</title></head><body><script>bad()</script><h1>Oak board</h1><p>Price &amp; stock<br>£12.50</p><style>p{}</style></body></html>');
  assert.equal(text, 'Oak board\nPrice & stock\n£12.50');
});

test('turning web off also turns the browser off, and nothing but film jobs can download', () => {
  const { allowedFor } = require('../cockerel-vm/service');
  assert.ok(allowedFor('assistant').includes('Bash(cockerel-tool browse:*)'));
  const off = allowedFor('assistant', ['web']);
  assert.ok(!off.includes('WebSearch') && !off.includes('Bash(cockerel-tool browse:*)'));
  assert.ok(!allowedFor('media').includes('Bash(cockerel-tool browse:*)'));
  for (const mode of ['assistant', 'scheduled']) assert.ok(!allowedFor(mode).some((t) => /cockerel-tool (fetch|find|library):/.test(t)), `${mode} cannot download`);
  const sched = allowedFor('scheduled');
  for (const t of ['remember', 'schedule', 'task', 'remind', 'email']) assert.ok(!sched.includes(`Bash(cockerel-tool ${t}:*)`), `a job cannot ${t}`);
});
