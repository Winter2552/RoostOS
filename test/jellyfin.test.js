'use strict';

// The Jellyfin link, against a small fake Jellyfin that answers the calls
// Roost makes (checked against a real Jellyfin 10.10 by hand).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const twoStep = require('../src/twostep');

const KEY = 'fake-api-key';
let fake;
let jfUrl;
let server;
let base;
let dataDir;
const jf = { page: false, users: [], tokens: new Map(), seen: [], resume: {}, oldResume: false };

function fakeJellyfin() {
  let n = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const auth = req.headers.authorization || '';
    const token = (auth.match(/Token="([^"]+)"/) || [])[1];
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    jf.seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, token, enc: req.headers['accept-encoding'] });
    const isKey = token === KEY;
    if (req.url === '/System/Info') return isKey ? json(200, { ServerName: 'Home', Version: '10.10.7' }) : json(401);
    if (req.url === '/Users' && req.method === 'GET') return isKey ? json(200, jf.users) : json(401);
    if (req.url === '/Users/New') {
      const u = { Id: `u${++n}`, Name: body.Name, Password: body.Password, Policy: { IsAdministrator: false, IsDisabled: false } };
      jf.users.push(u);
      return json(200, u);
    }
    let m = req.url.match(/^\/Users\/(\w+)\/(Password|Policy)$/);
    if (m) {
      const u = jf.users.find((x) => x.Id === m[1]);
      if (m[2] === 'Password') u.Password = body.NewPw;
      else u.Policy = body;
      return json(204);
    }
    if (req.url === '/Users/AuthenticateByName') {
      const u = jf.users.find((x) => x.Name === body.Username && x.Password === body.Pw && !x.Policy.IsDisabled);
      if (!u) return json(401);
      const t = `tok${++n}`;
      jf.tokens.set(t, { user: u.Id, device: (auth.match(/Device="([^"]+)"/) || [])[1] });
      return json(200, { AccessToken: t, ServerId: 'server1', User: { Id: u.Id } });
    }
    if (req.url === '/Sessions/Logout') {
      jf.tokens.delete(token);
      return json(204);
    }
    m = req.url.match(/^(?:\/UserItems\/Resume\?userId=(\w+)|\/Users\/(\w+)\/Items\/Resume\?)/);
    if (m) {
      if (!isKey) return json(401);
      if (m[1] && jf.oldResume) return json(404);
      const items = jf.resume[m[1] || m[2]] || [];
      return items === 'fail' ? json(500) : json(200, { Items: items });
    }
    if (req.url === '/redirect-me') {
      res.writeHead(302, { Location: '/web/' });
      return res.end();
    }
    if (req.url === '/web/index.html' && jf.page) {
      res.writeHead(200, { 'Content-Type': 'text/html', ETag: '"jf"' });
      return res.end('<html><head><title>Jellyfin</title><link rel="icon" href="favicon.ico"></head><body>home</body></html>');
    }
    if (req.url.startsWith('/web/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`jellyfin web ${req.url}`);
    }
    json(404);
  });
}

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const session = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('roost_session=') && c !== 'roost_session=');
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, cookie: session || null, location: res.headers.get('location') };
}

// Jellyfin work happens in the background after a reply; give it a moment.
const settle = () => new Promise((r) => setTimeout(r, 150));
const jfUser = (name) => jf.users.find((u) => u.Name === name);

let admin;
let adminSecret;
const setupStep = async () => (await call('GET', '/api/admin/setup', null, admin)).body.steps.find((st) => st.id === 'jellyfin-sign-in').done;

before(async () => {
  fake = fakeJellyfin();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  jfUrl = `http://127.0.0.1:${fake.address().port}`;
  // An existing Jellyfin admin with its own password, and an old account.
  jf.users.push({ Id: 'admin1', Name: 'raven', Password: 'jellyfin own pw', Policy: { IsAdministrator: true, IsDisabled: false } });
  jf.users.push({ Id: 'old1', Name: 'sam', Password: 'old jellyfin pw', Policy: { IsAdministrator: false, IsDisabled: true } });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-jf-'));
  server = createServer({ dataDir, maxFailedSignIns: 50 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  const start = await call('POST', '/api/me/two-step/start', null, admin);
  adminSecret = start.body.secret;
  await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(adminSecret, twoStep.currentStep()) }, admin);
});

after(() => {
  server.close();
  if (fake.listening) fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Jellyfin is off until an admin connects it', async () => {
  const view = await call('GET', '/api/admin/jellyfin', null, admin);
  assert.deepEqual(view.body, { url: '', keySaved: false, connected: false, skin: true });
  const apps = await call('GET', '/api/apps', null, admin);
  assert.equal(apps.body.apps.find((a) => a.id === 'jellyfin').openUrl, undefined);
  assert.equal((await call('GET', '/jellyfin/', null, admin)).location, '/');
  assert.equal(await setupStep(), false);
});

test('a wrong API key is refused and not saved', async () => {
  const bad = await call('PUT', '/api/admin/jellyfin', { url: jfUrl, apiKey: 'nope' }, admin);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /API key was refused/);
  assert.equal((await call('GET', '/api/admin/jellyfin', null, admin)).body.url, '');
});

test('connecting shows the server and never sends the key back', async () => {
  const ok = await call('PUT', '/api/admin/jellyfin', { url: `${jfUrl}/`, apiKey: KEY }, admin);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { url: jfUrl, keySaved: true, connected: true, skin: true, serverName: 'Home', version: '10.10.7', accounts: 2 });
  const settings = await call('GET', '/api/admin/settings', null, admin);
  assert.equal(JSON.stringify(settings.body).includes(KEY), false);
  assert.equal(await setupStep(), true);
  // Saving again without a key keeps the saved one.
  assert.equal((await call('PUT', '/api/admin/jellyfin', { url: jfUrl }, admin)).status, 200);
});

test('only admins manage the Jellyfin link', async () => {
  await call('POST', '/api/admin/users', { username: 'mia', password: 'mia pass 12', apps: ['jellyfin'] }, admin);
  await settle();
  const mia = (await call('POST', '/api/login', { username: 'mia', password: 'mia pass 12' })).cookie;
  assert.equal((await call('GET', '/api/admin/jellyfin', null, mia)).status, 403);
  assert.equal((await call('PUT', '/api/admin/jellyfin', { url: '' }, mia)).status, 403);
});

test('new users get a Jellyfin account with the same password', async () => {
  assert.equal(jfUser('mia').Password, 'mia pass 12');
  await call('POST', '/api/admin/users', { username: 'nofilms', password: 'no films 12', apps: ['nest'] }, admin);
  await settle();
  assert.equal(jfUser('nofilms'), undefined);
});

test('signing in links an existing Jellyfin account and hands its sign-in to the opener', async () => {
  await call('POST', '/api/admin/users', { username: 'sam', password: 'sam pass 123', apps: ['jellyfin'] }, admin);
  await settle();
  const sam = await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' });
  await settle();
  assert.equal(jfUser('sam').Password, 'sam pass 123');
  assert.equal(jfUser('sam').Policy.IsDisabled, false);
  const apps = await call('GET', '/api/apps', null, sam.cookie);
  assert.equal(apps.body.apps.find((a) => a.id === 'jellyfin').openUrl, '/jellyfin/');
  const s = await call('GET', '/api/jellyfin/session', null, sam.cookie);
  assert.equal(s.body.userId, 'old1');
  assert.equal(s.body.serverId, 'server1');
  assert.ok(jf.tokens.has(s.body.token));
  const opener = await call('GET', '/jellyfin/', null, sam.cookie);
  assert.equal(opener.status, 200);
  assert.match(opener.body, /jellyfin_credentials/);
});

test('Jellyfin admin accounts are never changed', async () => {
  const before = jf.seen.length;
  await call('POST', '/api/login', { username: 'raven', password: 'correct horse' });
  await settle();
  assert.equal(jfUser('raven').Password, 'jellyfin own pw');
  assert.equal(jf.seen.slice(before).some((r) => r.url === '/Users/admin1/Password'), false);
});

test('Jellyfin is passed through only to people allowed to use it', async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' })).cookie;
  const page = await call('GET', '/jellyfin/web/index.html', null, sam);
  assert.equal(page.status, 200);
  assert.equal(page.body, 'jellyfin web /web/index.html');
  assert.equal(jf.seen.at(-1).cookie, undefined, "Roost's cookie stays with Roost");
  assert.equal((await call('GET', '/jellyfin/', null, null)).location, '/');
  const root = await call('GET', '/jellyfin', null, sam);
  assert.equal(root.location, '/jellyfin/');
  const nofilms = (await call('POST', '/api/login', { username: 'nofilms', password: 'no films 12' })).cookie;
  assert.equal((await call('GET', '/jellyfin/web/index.html', null, nofilms)).location, '/');
  assert.equal((await call('GET', '/api/jellyfin/session', null, nofilms)).status, 403);
});

test("Roostflix adds its skin to Jellyfin's page, and can be switched off", async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' })).cookie;
  jf.page = true;
  try {
    const on = await call('GET', '/jellyfin/web/index.html', null, sam);
    assert.match(on.body, /<title>Roostflix<\/title>/);
    assert.match(on.body, /<link rel="stylesheet" href="\/roostflix\/skin\.css\?v=[\w-]{12}">/);
    assert.match(on.body, /<script defer src="\/roostflix\/skin\.js\?v=[\w-]{12}"><\/script><\/head>/);
    assert.ok(!on.body.includes('favicon.ico'));
    assert.equal(jf.seen.findLast((r) => r.url === '/web/index.html').enc, 'identity', 'Roost asks for the page uncompressed to add to it');
    assert.equal((await fetch(`${base}/roostflix/skin.css`)).status, 200);
    // The dashboard card takes the new name.
    const apps = (await call('GET', '/api/apps', null, sam)).body.apps;
    assert.equal(apps.find((a) => a.id === 'jellyfin').name, 'Roostflix');

    assert.equal((await call('PUT', '/api/admin/roostflix', { on: false }, sam)).status, 403);
    assert.equal((await call('PUT', '/api/admin/roostflix', { on: false }, admin)).body.skin, false);
    assert.equal((await call('GET', '/api/admin/jellyfin', null, admin)).body.skin, false);
    const off = await call('GET', '/jellyfin/web/index.html', null, sam);
    assert.match(off.body, /<title>Jellyfin<\/title>/);
    assert.ok(!off.body.includes('roostflix'));
    assert.equal((await call('GET', '/api/apps', null, sam)).body.apps.find((a) => a.id === 'jellyfin').name, 'Jellyfin');

    assert.equal((await call('PUT', '/api/admin/roostflix', { on: true }, admin)).body.skin, true);
  } finally {
    jf.page = false;
  }
});

test("Jellyfin's own redirects stay under /jellyfin", async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' })).cookie;
  const res = await call('GET', '/jellyfin/redirect-me', null, sam);
  assert.equal(res.status, 302);
  assert.equal(res.location, '/jellyfin/web/');
});

test('signing out of Roost signs that browser out of Jellyfin', async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' })).cookie;
  await settle();
  const { token } = (await call('GET', '/api/jellyfin/session', null, sam)).body;
  assert.ok(jf.tokens.has(token));
  await call('POST', '/api/logout', null, sam);
  await settle();
  assert.equal(jf.tokens.has(token), false);
});

test('changing your password changes it in Jellyfin too', async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam pass 123' })).cookie;
  await call('PATCH', '/api/me', { currentPassword: 'sam pass 123', newPassword: 'sam new pass 1' }, sam);
  await settle();
  assert.equal(jfUser('sam').Password, 'sam new pass 1');
});

test('taking Jellyfin away switches the account off and ends its sign-ins', async () => {
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam new pass 1' })).cookie;
  await settle();
  const { token } = (await call('GET', '/api/jellyfin/session', null, sam)).body;
  const users = (await call('GET', '/api/admin/users', null, admin)).body.users;
  const id = users.find((u) => u.username === 'sam').id;
  await call('PATCH', `/api/admin/users/${id}`, { apps: ['nest'] }, admin);
  await settle();
  assert.equal(jfUser('sam').Policy.IsDisabled, true);
  assert.equal(jf.tokens.has(token), false);
  await call('PATCH', `/api/admin/users/${id}`, { apps: ['jellyfin'] }, admin);
  await settle();
  assert.equal(jfUser('sam').Policy.IsDisabled, false);
});

test('deleting a user switches their Jellyfin account off', async () => {
  const users = (await call('GET', '/api/admin/users', null, admin)).body.users;
  await call('DELETE', `/api/admin/users/${users.find((u) => u.username === 'mia').id}`, null, admin);
  await settle();
  assert.equal(jfUser('mia').Policy.IsDisabled, true);
});

test('two-step sign-in links Jellyfin once the code is in', async () => {
  await call('POST', '/api/admin/users', { username: 'kai', password: 'kai pass 123', apps: ['jellyfin'] }, admin);
  await settle();
  const first = await call('POST', '/api/login', { username: 'kai', password: 'kai pass 123' });
  const kai = first.cookie;
  const start = await call('POST', '/api/me/two-step/start', null, kai);
  await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(start.body.secret, twoStep.currentStep()) }, kai);
  const step1 = await call('POST', '/api/login', { username: 'kai', password: 'kai pass 123' });
  assert.equal(step1.body.twoStep, true);
  const done = await call('POST', '/api/login/code', { ticket: step1.body.ticket, code: twoStep.codeAt(start.body.secret, twoStep.currentStep() + 1) });
  assert.equal(done.status, 200);
  const s = await call('GET', '/api/jellyfin/session', null, done.cookie);
  assert.ok(jf.tokens.has(s.body.token));
});

test('the dashboard shows what you were part way through', async () => {
  jf.resume.old1 = [
    { Id: 'ep1', ServerId: 'server1', Type: 'Episode', Name: 'Pilot', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2,
      RunTimeTicks: 30 * 600000000, UserData: { PlaybackPositionTicks: 6 * 600000000, PlayedPercentage: 20 }, ImageTags: { Primary: 'tagA' } },
    { Id: 'film1', ServerId: 'server1', Type: 'Movie', Name: 'Film', RunTimeTicks: 100 * 600000000,
      UserData: { PlaybackPositionTicks: 25 * 600000000, PlayedPercentage: 25.4 }, ImageTags: { Primary: 'tagP' }, BackdropImageTags: ['tagB'] },
    { Id: 'bad"id', Type: 'Movie', Name: 'Skipped' },
  ];
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'sam new pass 1' })).cookie;
  const before = jf.seen.length;
  const res = await call('GET', '/api/jellyfin/resume', null, sam);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [
    { id: 'ep1', serverId: 'server1', title: 'Show', subtitle: 'Pilot', where: 'S1 E2', minutesLeft: 24, percent: 20,
      image: '/jellyfin/Items/ep1/Images/Primary?fillWidth=480&quality=80&tag=tagA' },
    { id: 'film1', serverId: 'server1', title: 'Film', subtitle: '', where: null, minutesLeft: 75, percent: 25,
      image: '/jellyfin/Items/film1/Images/Backdrop/0?fillWidth=480&quality=80&tag=tagB' },
  ]);
  assert.equal(jf.seen.slice(before).find((r) => r.url.includes('Resume')).token, KEY);
  // A second look within the cache time doesn't ask Jellyfin again.
  const asked = jf.seen.length;
  await call('GET', '/api/jellyfin/resume', null, sam);
  assert.equal(jf.seen.length, asked);
  // The opener takes you straight to that item's page.
  const opener = await call('GET', '/jellyfin/', null, sam);
  assert.match(opener.body, /details/);
});

test('Continue watching is empty for people without Jellyfin, and works on older Jellyfin', async () => {
  const nofilms = (await call('POST', '/api/login', { username: 'nofilms', password: 'no films 12' })).cookie;
  assert.deepEqual((await call('GET', '/api/jellyfin/resume', null, nofilms)).body, { items: [] });
  assert.equal((await call('GET', '/api/jellyfin/resume', null, null)).status, 401);
  await call('POST', '/api/admin/users', { username: 'lee', password: 'lee pass 123', apps: ['jellyfin'] }, admin);
  await call('POST', '/api/admin/users', { username: 'ana', password: 'ana pass 123', apps: ['jellyfin'] }, admin);
  await settle();
  jf.oldResume = true;
  jf.resume[jfUser('lee').Id] = [{ Id: 'film2', Type: 'Movie', Name: 'Old', UserData: { PlayedPercentage: 50 } }];
  const lee = (await call('POST', '/api/login', { username: 'lee', password: 'lee pass 123' })).cookie;
  const res = await call('GET', '/api/jellyfin/resume', null, lee);
  assert.equal(res.body.items[0].id, 'film2');
  assert.equal(res.body.items[0].image, null);
  jf.oldResume = false;
  // A Jellyfin error just means an empty row.
  jf.resume[jfUser('ana').Id] = 'fail';
  const ana = (await call('POST', '/api/login', { username: 'ana', password: 'ana pass 123' })).cookie;
  const failed = await call('GET', '/api/jellyfin/resume', null, ana);
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.body, { items: [] });
});

test('a Jellyfin that is down never blocks Roost', async () => {
  await call('PUT', '/api/admin/jellyfin', { url: jfUrl }, admin);
  fake.close();
  fake.closeAllConnections();
  const res = await call('POST', '/api/login', { username: 'kai', password: 'kai pass 123' });
  assert.equal(res.status, 200);
  const view = await call('GET', '/api/admin/jellyfin', null, admin);
  assert.equal(view.body.connected, false);
});

test('turning the link off restores the plain Jellyfin card', async () => {
  const off = await call('PUT', '/api/admin/jellyfin', { url: '' }, admin);
  assert.equal(off.body.url, '');
  const apps = await call('GET', '/api/apps', null, admin);
  assert.equal(apps.body.apps.find((a) => a.id === 'jellyfin').openUrl, undefined);
});
