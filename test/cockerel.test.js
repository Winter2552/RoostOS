'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cockerel, GB } = require('../src/cockerel');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

const SECRET = 'a-long-shared-secret-for-tests-1234';

function unit(settings = {}, now = Date.now()) {
  const store = { db: { settings: { cockerel: { url: 'http://192.168.4.40:7070', secret: SECRET, ...settings } } }, save() {} };
  let n = 0;
  return new Cockerel({ store, newId: () => `id${++n}`, now: () => now });
}

test('only a fresh, correctly signed message from the VM is believed', () => {
  const c = unit();
  const body = JSON.stringify({ type: 'log', text: 'hi' });
  const h = c.headers(body);
  assert.equal(c.verify(h, body), true);
  assert.equal(c.verify(h, body + ' '), false, 'changed body');
  assert.equal(c.verify({ ...h, 'x-roost-sig': 'f'.repeat(64) }, body), false, 'wrong signature');
  assert.equal(c.verify({}, body), false, 'unsigned');
  const old = unit({}, Date.now() - 10 * 60 * 1000).headers(body);
  assert.equal(c.verify(old, body), false, 'stale');
  assert.equal(unit({ secret: '' }).verify(h, body), false, 'not set up');
});

test('under the limits he acts alone; over them he asks', () => {
  const c = unit({ sizeGb: 5, dayGb: 8 });
  assert.equal(c.check(2 * GB).decision, 'auto');
  assert.equal(c.check(6 * GB).decision, 'ask');
  assert.equal(c.check(0).decision, 'ask', 'unknown size');
  c.spend(4 * GB);
  assert.equal(c.check(5 * GB).decision, 'ask', 'would pass the day allowance');
  assert.equal(c.check(3 * GB).decision, 'auto');
});

test('the day allowance starts again tomorrow', () => {
  let now = Date.UTC(2026, 9, 30, 12);
  const store = { db: { settings: { cockerel: { url: 'http://10.0.0.2:7070', secret: SECRET } } }, save() {} };
  const c = new Cockerel({ store, newId: () => 'x', now: () => now });
  c.spend(3 * GB);
  assert.equal(c.dayBytes(), 3 * GB);
  now += 24 * 3600 * 1000;
  assert.equal(c.dayBytes(), 0);
});

test('the feed and jobs keep only the latest', () => {
  const c = unit();
  for (let i = 0; i < 230; i++) c.add({ kind: 'note', text: `n${i}` });
  assert.equal(c.data().log.length, 200);
  c.setJob({ id: 'j1', title: 'Big Buck Bunny', state: 'Downloading', progress: 140 });
  assert.equal(c.data().jobs[0].progress, 100);
  c.setJob({ id: 'j1', state: 'nonsense' });
  assert.equal(c.data().jobs[0].state, 'Downloading');
});

// ---------- through the server ----------
let server;
let base;
let dataDir;
let cookie;
const sent = [];
const mails = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-cockerel-'));
  const fetchImpl = async (url, opts) => {
    sent.push({ url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    return new Response(JSON.stringify(url.endsWith('/chat') ? { reply: 'On it.' } : { ok: true }), { status: 200 });
  };
  server = createServer({ sendMail: async (m, msg) => { mails.push(msg); }, dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1', coffeeOptions: { fetchImpl, calendarFetch: async () => new Response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Dentist\r\nDTSTART:20300105T090000Z\r\nDTEND:20300105T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR', { status: 200 }) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, cookie);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, ck, headers = {}, raw) {
  const h = { ...headers };
  if (body !== undefined && body !== null && !raw) h['Content-Type'] = 'application/json';
  if (raw) h['Content-Type'] = 'application/json';
  if (ck) h.Cookie = ck;
  const res = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* none */ }
  const set = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: set ? set.split(';')[0] : undefined };
}

function signed(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-roost-ts': ts, 'x-roost-sig': crypto.createHmac('sha256', SECRET).update(`${ts}\n${body}`).digest('hex') };
}

const hook = (payload) => { const raw = JSON.stringify(payload); return call('POST', '/api/cockerel/hook', null, null, signed(raw), raw); };

test('Cockerel is for admins only', async () => {
  assert.equal((await call('GET', '/api/cockerel')).status, 401);
  assert.equal((await call('POST', '/api/cockerel/chat', { text: 'hi' })).status, 401);
});

test('admin links him, and the secret never comes back', async () => {
  const bad = await call('PUT', '/api/admin/cockerel', { url: 'http://example.com:7070' }, cookie);
  assert.equal(bad.status, 400, 'only home-network addresses');
  const ok = await call('PUT', '/api/admin/cockerel', { url: 'http://192.168.4.40:7070', secret: SECRET, sizeGb: 4, dayGb: 12 }, cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { url: 'http://192.168.4.40:7070', hasSecret: true, paused: false, sizeGb: 4, dayGb: 12, tz: 'Europe/London', briefOn: false, briefTime: '07:30', toolsOff: [] });
  const settings = await call('GET', '/api/admin/settings', null, cookie);
  assert.ok(!JSON.stringify(settings.body).includes(SECRET));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8').includes(SECRET), 'kept encrypted');
});

test('a chat message goes to the VM signed and the reply comes back', async () => {
  const r = await call('POST', '/api/cockerel/chat', { text: 'Is Big Buck Bunny in the library?' }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply.text, 'On it.');
  const hit = sent.find((s) => s.url.endsWith('/chat'));
  assert.equal(hit.body.text, 'Is Big Buck Bunny in the library?');
  assert.match(hit.headers['x-roost-sig'], /^[0-9a-f]{64}$/);
  const feed = await call('GET', '/api/cockerel', null, cookie);
  assert.deepEqual(feed.body.log.slice(-2).map((e) => e.kind), ['you', 'cockerel']);
});

test('the VM can only report with a good signature', async () => {
  assert.equal((await call('POST', '/api/cockerel/hook', { type: 'log', text: 'x' })).status, 401);
  assert.equal((await hook({ type: 'log', text: 'Checked the library' })).status, 200);
  assert.equal((await hook({ type: 'job', id: 'j1', title: 'Sintel', state: 'Finding' })).body.job.state, 'Finding');
  assert.equal((await hook({ type: 'check', bytes: 1 * GB })).body.decision, 'auto');
  assert.equal((await hook({ type: 'check', bytes: 9 * GB })).body.decision, 'ask');
  assert.equal((await hook({ type: 'nope' })).status, 400);
});

test('a file he sends lands in Nest under Cockerel and shows in the chat', async () => {
  const data = Buffer.from('# Notes\nhello').toString('base64');
  const r = await hook({ type: 'file', name: 'notes.md', data });
  assert.equal(r.status, 200);
  const entry = (await call('GET', '/api/cockerel', null, cookie)).body.log.find((e) => e.kind === 'file');
  assert.equal(entry.file.name, 'notes.md');
  const dl = await fetch(`${base}/api/nest/files/${entry.file.id}`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), '# Notes\nhello');
  assert.equal((await hook({ type: 'file', name: 'x.md', data: '' })).status, 413, 'empty is refused');
});

test('his notebook: remember, tasks, reminders, and a job that waits for Raven', async () => {
  assert.equal((await hook({ type: 'remember', text: 'Raven lives in Leeds' })).status, 200);
  assert.equal((await hook({ type: 'task', text: 'Order oak boards', due: '2026-12-01' })).status, 200);
  assert.equal((await hook({ type: 'task', text: 'x', due: 'soon' })).status, 400);
  const soon = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await hook({ type: 'remind', at: soon, text: 'Call Sam' })).status, 200);
  assert.equal((await hook({ type: 'remind', at: '2001-01-01 09:00', text: 'Old' })).status, 400, 'not in the past');
  const lines = (await hook({ type: 'list', kind: 'task' })).body.lines;
  assert.match(lines[0], /Order oak boards \(due 2026-12-01\)/);
  const job = await hook({ type: 'schedule', text: 'Check the price of oak at Wickes', every: 'day', time: '08:00' });
  assert.equal(job.status, 200);
  assert.equal(job.body.item.approved, false, 'waits for a yes');
  const view = await call('GET', '/api/cockerel/assistant', null, cookie);
  assert.equal(view.body.memories.length, 1);
  assert.equal(view.body.jobs[0].approved, false);
  const ask = (await call('GET', '/api/cockerel', null, cookie)).body.log.find((e) => e.askId === `job-${job.body.item.id}`);
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Yes, do it' }, cookie)).status, 200);
  assert.equal((await call('GET', '/api/cockerel/assistant', null, cookie)).body.jobs[0].approved, true);
  assert.equal((await call('GET', '/api/cockerel/assistant')).status, 401);
  assert.equal((await call('POST', '/api/cockerel/assistant', { op: 'delete', kind: 'memory', id: view.body.memories[0].id }, cookie)).body.memories.length, 0);
  assert.equal((await call('PUT', '/api/admin/cockerel', { tz: 'Not/AZone' }, cookie)).status, 400);
  assert.equal((await call('PUT', '/api/admin/cockerel', { briefOn: true, briefTime: '06:45' }, cookie)).body.briefTime, '06:45');
});

test('calendar link and mailbox are set by Raven, and he can only read them', async () => {
  assert.equal((await hook({ type: 'inbox' })).status, 409, 'no mailbox yet');
  assert.equal((await hook({ type: 'calendar' })).body.linked, 0);
  const bad = await call('POST', '/api/admin/cockerel/connections', { op: 'addCalendar', name: 'Home', url: 'http://x.example.com/a.ics' }, cookie);
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/admin/cockerel/connections', { op: 'addCalendar', name: 'Home', url: 'https://calendar.example.com/secret.ics' }, cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.calendars.map((c) => c.name), ['Home']);
  assert.ok(!JSON.stringify(ok.body).includes('secret.ics'), 'the link is never shown again');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'roost.json'), 'utf8').includes('secret.ics'), 'kept encrypted');
  assert.equal((await hook({ type: 'calendar', days: 7 })).body.linked, 1);
  assert.equal((await call('GET', '/api/admin/cockerel/connections')).status, 401);
});

test('anything that changes something waits for Raven, and a no does nothing', async () => {
  assert.equal((await hook({ type: 'action', kind: 'format-the-disk' })).status, 400);
  assert.equal((await hook({ type: 'action', kind: 'email', to: 'not-an-address', subject: 's', text: 't' })).status, 400);
  assert.equal((await hook({ type: 'action', kind: 'email', to: 'sam@example.com', subject: 'Hi', text: 'Hello' })).status, 409, 'Roost has no mail set up in this test');
  assert.match((await hook({ type: 'roost-status' })).body.lines[0], /^Backups:/);
  const asked = await hook({ type: 'action', kind: 'backup' });
  assert.equal(asked.status, 200);
  const log = () => call('GET', '/api/cockerel', null, cookie).then((r) => r.body.log);
  const ask = (await log()).find((e) => e.askId && e.askId.startsWith('act-'));
  assert.equal(ask.text, 'Start a backup now?');
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'No' }, cookie)).status, 200);
  assert.equal((await log()).slice(-1)[0].text, 'Okay, I did not do it.');
  await hook({ type: 'action', kind: 'backup' });
  const again = (await log()).filter((e) => e.askId && e.askId.startsWith('act-')).pop();
  assert.equal((await call('POST', '/api/cockerel/answer', { id: again.id, choice: 'Yes, go ahead' }, cookie)).status, 200);
  assert.match((await log()).slice(-1)[0].text, /backup service is not running/i, 'a yes runs it, and it is checked again then');
});

test('an email he writes goes out only after Raven says yes, and at most five a day', async () => {
  await call('PATCH', '/api/admin/settings', { publicUrl: 'https://roostos.network', mail: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'u', password: 'p', from: 'server@roostos.network' } }, cookie);
  const log = () => call('GET', '/api/cockerel', null, cookie).then((r) => r.body.log);
  assert.equal((await hook({ type: 'action', kind: 'email', to: 'Sam@Example.com', subject: 'Dinner', text: 'Friday at 7?' })).status, 200);
  assert.equal(mails.length, 0, 'nothing sent yet');
  const ask = (await log()).filter((e) => e.askId && e.askId.startsWith('act-')).pop();
  assert.match(ask.text, /to sam@example.com\?\nSubject: Dinner\n\nFriday at 7\?/, 'Raven sees exactly what would go');
  await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Yes, go ahead' }, cookie);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'sam@example.com');
  assert.equal(mails[0].subject, 'Dinner');
  for (let i = 0; i < 4; i++) {
    await hook({ type: 'action', kind: 'email', to: 'sam@example.com', subject: `n${i}`, text: 'x' });
    const a = (await log()).filter((e) => e.askId && e.askId.startsWith('act-')).pop();
    await call('POST', '/api/cockerel/answer', { id: a.id, choice: 'Yes, go ahead' }, cookie);
  }
  assert.equal(mails.length, 5);
  assert.equal((await hook({ type: 'action', kind: 'email', to: 'sam@example.com', subject: 'six', text: 'x' })).status, 429);
});

test('his question reaches Raven and the answer goes back', async () => {
  assert.equal((await hook({ type: 'ask', askId: 'a1', text: 'Sintel was requested. Find it?', options: ['Yes', 'No'] })).status, 200);
  const ask = (await call('GET', '/api/cockerel', null, cookie)).body.log.find((e) => e.askId === 'a1');
  assert.deepEqual(ask.options, ['Yes', 'No']);
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Maybe' }, cookie)).status, 400);
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'Yes' }, cookie)).status, 200);
  assert.deepEqual(sent.find((s) => s.url.endsWith('/answer')).body, { askId: 'a1', choice: 'Yes' });
  assert.equal((await call('POST', '/api/cockerel/answer', { id: ask.id, choice: 'No' }, cookie)).status, 409, 'once only');
});

test('a movie request wakes him', async () => {
  sent.length = 0;
  server.push.notify({ title: 'Movie request', body: 'Sam asks for Sintel', tag: 'movie-1', url: '/#/admin' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.find((s) => s.url.endsWith('/event')).body.body, 'Sam asks for Sintel');
  sent.length = 0;
  server.push.notify({ title: 'Now on Roostflix', body: 'Sintel', tag: 'movie-1', url: '/' }, 'someone-else');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0, 'a note to one person is not for him');
});

test('paused, he hears nothing and does nothing', async () => {
  await call('PUT', '/api/admin/cockerel', { paused: true }, cookie);
  sent.length = 0;
  server.push.notify({ title: 'Movie request', body: 'x', tag: 't' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
  assert.equal((await call('POST', '/api/cockerel/chat', { text: 'hi' }, cookie)).status, 409);
  assert.equal((await hook({ type: 'check', bytes: 1 })).status, 409, 'nothing new starts');
  assert.equal((await hook({ type: 'job', id: 'j2', title: 'x' })).status, 200, 'a running download can still be filed');
  await call('PUT', '/api/admin/cockerel', { paused: false }, cookie);
});
