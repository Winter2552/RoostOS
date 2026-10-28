'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const secrets = require('../src/secrets');
const ai = require('../src/birdhouse-ai');
const { setUpTwoStep } = require('./helpers');

// A stand-in for api.anthropic.com that streams a canned reply. The real API
// is not called from tests.
let replies = [];
let seen = [];
let fake;
let server;
let dataDir;
let base;
let cookie;

const sse = (text, input = 1000, output = 2000) => [
  { type: 'message_start', message: { usage: { input_tokens: input } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, 20) } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(20) } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      const next = replies.shift();
      if (next && next.status) { res.writeHead(next.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })); return; }
      if (next === undefined) { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(typeof next === 'object' ? sse(next.text, 1000, next.output) : sse(next));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-ai-'));
  server = createServer({ dataDir, probeTimeoutMs: 300, maxFailedSignIns: 50, aiBase: `http://127.0.0.1:${fake.address().port}` });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'raven', password: 'a long enough pass 1', serverName: 'T' }) });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('roost_session='));
  await setUpTwoStep(call, cookie);
});

after(async () => {
  server.closeAllConnections();
  fake.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method, url, body, ck = cookie) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('a secret is sealed, opens again, and does not open with the wrong key or a damaged box', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sec-'));
  const box = secrets.seal(dir, 'sk-ant-hello');
  assert.ok(!JSON.stringify(box).includes('hello'));
  assert.equal(secrets.open(dir, box), 'sk-ant-hello');
  assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777, 0o600);
  assert.equal(secrets.open(dir, { ...box, data: Buffer.from('xxxxxxxxxxxx').toString('base64') }), null);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sec-'));
  assert.equal(secrets.open(other, box), null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('tiers cost more as they think harder', () => {
  const costs = ai.TIER_IDS.map(ai.estimate);
  assert.deepEqual([...costs].sort((a, b) => a - b), costs);
  assert.ok(costs[0] < 0.01 && costs[3] < 2);
});

test('without a key Design with Claude is off and the design route refuses', async () => {
  assert.equal((await call('GET', '/api/birdhouse')).body.ai, null);
  assert.equal((await call('POST', '/api/birdhouse/design', { prompt: 'a stool', tier: 'quick' })).status, 403);
});

test('the key is stored encrypted, never sent back, and bad keys are refused', async () => {
  assert.equal((await call('PUT', '/api/admin/birdhouse-ai', { key: 'not a key' })).status, 400);
  const key = `sk-ant-${'a'.repeat(30)}WXYZ`;
  const saved = await call('PUT', '/api/admin/birdhouse-ai', { key, monthCap: 5, dayCap: 3 });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.on, saved.body.last4], [true, 'WXYZ']);
  assert.ok(!JSON.stringify(saved.body).includes(key));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8').includes(key));
  const view = await call('GET', '/api/admin/settings');
  assert.ok(!JSON.stringify(view.body).includes(key));
  assert.equal(view.body.settings.birdhouseAi.last4, 'WXYZ');
  const tiers = (await call('GET', '/api/birdhouse')).body.ai;
  assert.deepEqual(tiers.tiers.map((t) => t.id), ['quick', 'balanced', 'creative', 'deep']);
});

const good = JSON.stringify({ template: 'custom', name: 'Record shelf', notes: 'Frame and skins.', boards: [
  { name: 'Post', x: 0, y: 0, z: 0, w: 44, d: 44, h: 600 }, { name: 'Top', x: 0, y: 0, z: 600, w: 400, d: 300, h: 18 } ] });

test('a design is asked for with the chosen tier, read back, and counted', async () => {
  replies = [{ text: `Here you go\n\`\`\`json\n${good}\n\`\`\``, output: 100000 }]; // about $2
  seen = [];
  const r = await call('POST', '/api/birdhouse/design', { prompt: 'a record shelf', tier: 'creative' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Record shelf');
  assert.equal(r.body.d.template, 'custom');
  assert.equal(r.body.d.boards.length, 2);
  assert.equal(seen[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(seen[0].body.output_config, { effort: 'high' });
  assert.equal(seen[0].body.stream, true);
  assert.match(seen[0].headers['x-api-key'], /^sk-ant-/);
  assert.equal(seen[0].body.messages[0].content, 'a record shelf');
  assert.ok(r.body.cost > 0);
  const used = (await call('GET', '/api/admin/settings')).body.settings.birdhouseAi;
  assert.equal(used.today, 1);
  assert.ok(used.spent > 0);
});

test('an unreadable reply gets one repair attempt, and a second failure is reported', async () => {
  replies = ['I could not', `\`\`\`json\n${good}\n\`\`\``];
  seen = [];
  assert.equal((await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'quick' })).status, 200);
  assert.equal(seen.length, 2);
  assert.match(seen[1].body.messages[2].content, /could not be used/);
  replies = ['nope', 'still nope'];
  assert.equal((await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'quick' })).status, 422);
});

test('the daily limit stops further designs, and API errors are explained', async () => {
  assert.equal((await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'quick' })).status, 429);
  await call('PUT', '/api/admin/birdhouse-ai', { dayCap: 50 });
  replies = [{ status: 401 }];
  const r = await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'quick' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /did not accept the key/);
});

test('the monthly limit is checked before asking', async () => {
  await call('PUT', '/api/admin/birdhouse-ai', { monthCap: 1 });
  seen = [];
  const r = await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'deep' });
  assert.equal(r.status, 429);
  assert.equal(seen.length, 0);
});

test('removing the key turns it off', async () => {
  await call('PUT', '/api/admin/birdhouse-ai', { remove: true });
  assert.equal((await call('GET', '/api/birdhouse')).body.ai, null);
  assert.equal((await call('POST', '/api/birdhouse/design', { prompt: 'x', tier: 'quick' })).status, 403);
});

test('a custom plan saves and comes back', async () => {
  const model = require('../public/birdhouse-model');
  const d = model.readDesign(good).d;
  const made = await call('POST', '/api/birdhouse/plans', { name: 'Record shelf', plan: d });
  assert.equal(made.body.plan.boards.length, 2);
  assert.equal(made.body.plan.notes, 'Frame and skins.');
});
