'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lib = require('../cockerel-vm/lib');

test('a magnet is known by its hash, and only links Raven typed are picked out', () => {
  const a = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Film&tr=udp%3A%2F%2Fone';
  const b = 'magnet:?dn=Other&xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&tr=udp%3A%2F%2Ftwo';
  assert.equal(lib.linkKey(a), lib.linkKey(b));
  const keys = lib.linksIn(`Get this ${a} and also https://example.com/x.mkv, thanks`);
  assert.deepEqual(keys, [lib.linkKey(a), 'https://example.com/x.mkv']);
  assert.deepEqual(lib.linksIn('no links here, just http://plain.example'), []);
});

test("Raven's standing confirmation covers links he pasted, and nothing else", async () => {
  const secret = 'entitled-test-secret-0123456789';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockerel-ent-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const n of ['ip', 'aria2c']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen = [];
  let on = true;
  const roost = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    assert.ok(lib.verify(secret, req.headers, body));
    const msg = JSON.parse(body);
    seen.push(msg);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(msg.type === 'entitled' ? { on, at: '2026-11-11T13:00:00.000Z' } : msg.type === 'check' ? { decision: 'auto' } : { ok: true }));
  });
  await new Promise((r) => roost.listen(0, '127.0.0.1', r));
  const home = path.join(root, 'home');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COCKEREL_HOME: home, MEDIA_ROOT: path.join(root, 'media'), INCOMING_DIR: path.join(root, 'media', 'incoming'), ROOST_URL: `http://127.0.0.1:${roost.address().port}`, COCKEREL_SECRET: secret };
  const tool = (...args) => new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, '..', 'cockerel-vm', 'tool.js'), ...args], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const typedMagnet = 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Mine';
  const otherMagnet = 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=FromAnEmail';
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'typed.json'), JSON.stringify([{ key: lib.linkKey(typedMagnet), at: Date.now() }]));
  const asked = (id) => seen.some((m) => m.type === 'ask' && m.askId === `entitled-${id}`);
  try {
    // 1. Switch on, link he typed: starts without asking, and says why in the log.
    let r = await tool('fetch', typedMagnet, '--job', 'a1', '--name', 'Mine', '--year', '2020');
    assert.equal(r.code, 0, r.out);
    assert.ok(!asked('a1'));
    assert.ok(seen.some((m) => m.type === 'log' && /standing confirmation/.test(m.text)));
    assert.ok(seen.some((m) => m.type === 'spend'), 'the download went ahead');
    // 2. Switch on, but the link did not come from his own message: still asks.
    seen.length = 0;
    r = await tool('fetch', otherMagnet, '--job', 'a2', '--name', 'FromAnEmail');
    assert.ok(asked('a2'));
    assert.ok(!seen.some((m) => m.type === 'entitled'), 'Roost is not even asked');
    assert.ok(!seen.some((m) => m.type === 'spend'));
    // 3. A used job id cannot carry the confirmation over to a different link.
    seen.length = 0;
    await tool('fetch', otherMagnet, '--job', 'a1', '--name', 'Swapped');
    assert.ok(asked('a1'), 'a different link under the same job id asks');
    // 4. Switch off in Admin: his own link asks again, at once.
    on = false;
    seen.length = 0;
    await tool('fetch', typedMagnet, '--job', 'a3', '--name', 'Mine');
    assert.ok(asked('a3'));
    // 5. An old link (typed more than two hours ago) does not count.
    on = true;
    fs.writeFileSync(path.join(state, 'typed.json'), JSON.stringify([{ key: lib.linkKey(typedMagnet), at: Date.now() - 3 * 3600e3 }]));
    seen.length = 0;
    await tool('fetch', typedMagnet, '--job', 'a4', '--name', 'Mine');
    assert.ok(asked('a4'));
  } finally {
    roost.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a bare magnet pasted into the chat goes to the download run', () => {
  const { modeFor } = require('../cockerel-vm/service');
  assert.equal(modeFor('magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Mine'), 'media');
  assert.equal(modeFor('What is a magnet link?'), 'assistant');
});
