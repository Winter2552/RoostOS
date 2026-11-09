'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

let server;
let base;
let dataDir;
let admin;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-immich-test-'));
  server = createServer({ dataDir, nestDir: path.join(dataDir, 'files'), probeTimeoutMs: 300 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  await call('POST', '/api/admin/users', { username: 'sam', password: 'password1', limitGb: 1 }, admin);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

// The body the Immich app sends: text fields first, the file last.
function multipart(fields, filename, data, type = 'image/jpeg') {
  const B = '----dart-http-boundary-abc123';
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${B}\r\ncontent-type: ${type}\r\ncontent-disposition: form-data; name="assetData"; filename="${filename}"\r\n\r\n`), data, Buffer.from(`\r\n--${B}--\r\n`));
  return { type: `multipart/form-data; boundary=${B}`, body: Buffer.concat(parts) };
}

// Sent in small odd-sized writes so field and boundary edges fall across pieces.
function post(pathname, headers, body, piece = 0) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method: 'POST', headers: { ...headers, 'Content-Length': body.length } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (!piece) req.end(body);
    else {
      for (let i = 0; i < body.length; i += piece) req.write(body.subarray(i, i + piece));
      req.end();
    }
  });
}

test('the Immich app can find Roost and sign in with a username or a backup key', async () => {
  assert.deepEqual(await (await fetch(`${base}/.well-known/immich`)).json(), { api: { endpoint: '/api' } });
  assert.deepEqual(await (await fetch(`${base}/api/server/ping`)).json(), { res: 'pong' });
  const v = await (await fetch(`${base}/api/server/version`)).json();
  assert.ok(Number.isInteger(v.major) && Number.isInteger(v.minor) && Number.isInteger(v.patch));
  assert.equal((await (await fetch(`${base}/api/server/features`)).json()).passwordLogin, true);
  assert.equal((await call('GET', '/api/server/config')).body.isInitialized, true);

  const bad = await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/login', { email: 'Sam@roost', password: 'password1' });
  assert.equal(ok.status, 201);
  assert.match(ok.body.accessToken, /^[0-9a-f]{64}$/);
  // Like Immich's server, the sign-in also sets its three cookies (the phone app's next requests rely on them).
  const raw = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sam@roost', password: 'password1' }) });
  const cookies = raw.headers.getSetCookie();
  assert.deepEqual(cookies.map((c) => c.split('=')[0]).sort(), ['immich_access_token', 'immich_auth_type', 'immich_is_authenticated']);
  const set = Object.fromEntries(cookies.map((c) => [c.split('=')[0], c]));
  assert.match(set.immich_access_token, /^immich_access_token=[0-9a-f]{64}; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly$/);
  assert.doesNotMatch(set.immich_is_authenticated, /HttpOnly/);
  const jar = cookies.map((c) => c.split(';')[0]).join('; ');
  assert.equal((await fetch(`${base}/api/users/me`, { headers: { Cookie: jar } })).status, 200);
  assert.equal(ok.body.userEmail, 'sam@roost');

  // Every way the app might send its token.
  for (const headers of [{ Authorization: `Bearer ${ok.body.accessToken}` }, { 'x-immich-user-token': ok.body.accessToken }, { 'x-api-key': ok.body.accessToken }, { Cookie: `immich_is_authenticated=true; immich_access_token=${ok.body.accessToken}` }]) {
    const me = await fetch(`${base}/api/users/me`, { headers });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).name, 'sam');
    assert.deepEqual(await (await fetch(`${base}/api/auth/validateToken`, { method: 'POST', headers })).json(), { authStatus: true });
  }
  assert.equal((await fetch(`${base}/api/users/me`)).status, 401);
  // The app reads the preferences with the user, and signs out again if any group is missing.
  const prefs = await (await fetch(`${base}/api/users/me/preferences`, { headers: { Authorization: `Bearer ${ok.body.accessToken}` } })).json();
  assert.deepEqual(Object.keys(prefs).sort(), ['albums', 'cast', 'download', 'emailNotifications', 'folders', 'memories', 'people', 'purchase', 'ratings', 'recentlyAdded', 'sharedLinks', 'tags']);
  assert.equal(prefs.albums.defaultAssetOrder, 'desc');

  // Two-step accounts sign in with a backup key instead of the password.
  const refused = await call('POST', '/api/auth/login', { email: 'raven@roost', password: 'correct horse' });
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /backup key/);
  const key = (await call('POST', '/api/me/backup-key', { name: 'iPhone' }, admin)).body.key;
  const viaKey = await call('POST', '/api/auth/login', { email: 'raven@roost', password: key });
  assert.equal(viaKey.status, 201);
  assert.equal(viaKey.body.accessToken, key);
  // A key only works for its own account.
  assert.equal((await call('POST', '/api/auth/login', { email: 'sam@roost', password: key })).status, 401);
});

test('photos from the Immich app land in Photos by year, once, and big ones stream through', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const auth = { Authorization: `Bearer ${token}` };
  const send = (id, name, data, extra = {}, piece = 0) => {
    const m = multipart({ deviceAssetId: id, deviceId: 'phone-1', fileCreatedAt: '2019-06-01T10:00:00.000Z', fileModifiedAt: '2019-06-01T10:00:00.000Z', isFavorite: 'false', duration: '0', ...extra }, name, data);
    return post('/api/assets', { ...auth, 'Content-Type': m.type }, m.body, piece);
  };

  const check = async (ids) => (await call('POST', '/api/assets/bulk-upload-check', { assets: ids.map((id) => ({ id, checksum: 'x' })) }, null)).status;
  assert.equal(await check(['A']), 401);
  const bulk = (ids) => fetch(`${base}/api/assets/bulk-upload-check`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ assets: ids.map((id) => ({ id, checksum: 'x' })) }) }).then((r) => r.json());
  assert.deepEqual((await bulk(['IMG_1'])).results.map((r) => r.action), ['accept']);

  const photo = Buffer.from('not really a jpeg, but bytes\r\n--look-alike\r\n');
  const first = await send('IMG_1', 'IMG_0001.JPG', photo, {}, 7);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, 'created');
  const again = await send('IMG_1', 'IMG_0001.JPG', photo);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { id: first.body.id, status: 'duplicate' });
  const known = (await bulk(['IMG_1', 'IMG_2'])).results;
  assert.deepEqual(known.map((r) => [r.action, r.reason || null]), [['reject', 'duplicate'], ['accept', null]]);
  const exist = await fetch(`${base}/api/assets/exist`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'phone-1', deviceAssetIds: ['IMG_1', 'IMG_9'] }) });
  assert.deepEqual(await exist.json(), { existingIds: ['IMG_1'] });

  // The file is exactly what was sent, in Photos/2019.
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  const root = (await call('GET', '/api/nest/folders/root', null, sam)).body;
  const photos = root.items.find((i) => i.name === 'Photos');
  const year = (await call('GET', `/api/nest/folders/${photos.id}`, null, sam)).body.items.find((i) => i.name === '2019');
  const files = (await call('GET', `/api/nest/folders/${year.id}`, null, sam)).body.items;
  assert.deepEqual(files.map((f) => f.name), ['IMG_0001.JPG']);
  const got = await fetch(`${base}/api/nest/files/${files[0].id}`, { headers: { Cookie: sam } });
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), photo);

  // A video bigger than one piece, with the hidden Live Photo half beside it.
  const big = Buffer.alloc(17 * 1024 * 1024, 'v');
  const video = await send('VID_1', 'MOV_0001.MOV', big, {}, 1 << 20);
  assert.equal(video.status, 201, JSON.stringify(video.body));
  const live = await send('LIVE_1', 'IMG_0002.MOV', Buffer.from('clip'), { visibility: 'hidden' });
  assert.equal(live.status, 201);
  assert.equal((await call('GET', '/api/backup/status', null, sam)).body.photos, 3);

  // A request that isn't an upload, or has no size, is refused rather than hung.
  assert.equal((await post('/api/assets', { ...auth, 'Content-Type': 'application/json' }, Buffer.from('{}'))).status, 400);
  assert.equal((await post('/api/assets', { ...auth, 'Content-Type': 'multipart/form-data; boundary=zz' }, Buffer.from('--zz\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--zz--\r\n'))).status, 400);
});

test('failed requests and sign-ins from the app are logged', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'wrong' });
    await fetch(`${base}/api/albums/x`);
  } finally {
    console.log = real;
  }
  assert.ok(lines.some((l) => l.startsWith('Immich app: POST /api/auth/login -> 401')), lines.join('|'));
  assert.ok(lines.some((l) => l.startsWith('Immich app: GET /api/albums/x -> 401 (headers sent: ')), lines.join('|'));
});

test('things the app asks for that Roost does not answer are a plain 404', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const res = await fetch(`${base}/api/albums/not-there`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});

test('a backed-up photo is dated from the phone, so Glint never has to open it to find out', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const m = multipart({ deviceAssetId: 'DATED_1', deviceId: 'phone-1', fileCreatedAt: '2017-03-04T05:06:07.000Z', fileModifiedAt: '2026-11-02T00:00:00.000Z' }, 'IMG_0099.JPG', Buffer.from('pixels'));
  const sent = await post('/api/assets', { Authorization: `Bearer ${token}`, 'Content-Type': m.type }, m.body);
  assert.equal(sent.status, 201);
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  const list = (await call('GET', '/api/glint/photos', null, sam)).body.items;
  const photo = list.find((p) => p.name === 'IMG_0099.JPG');
  assert.ok(photo, 'the photo is in the timeline');
  assert.equal(photo.taken, Date.parse('2017-03-04T05:06:07.000Z'));
});

test('the hidden half of a Live Photo from the app joins its photo, by name or by the moment it was taken', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const send = (id, name, data, created, extra = {}) => {
    const m = multipart({ deviceAssetId: id, deviceId: 'phone-1', fileCreatedAt: created, fileModifiedAt: created, ...extra }, name, Buffer.from(data), /MOV$/.test(name) ? 'video/quicktime' : 'image/heic');
    return post('/api/assets', { Authorization: `Bearer ${token}`, 'Content-Type': m.type }, m.body);
  };
  const T = '2018-08-08T08:08:08.000Z';
  const T2 = '2018-08-08T09:09:09.000Z';
  await send('L_A', 'IMG_0200.HEIC', 'still a', T);
  await send('L_B', 'IMG_0200.MOV', 'clip a', T, { visibility: 'hidden' });
  await send('L_C', 'IMG_0201.HEIC', 'still c', T2);
  await send('L_D', 'AAAA-1111.MOV', 'clip d', '2018-08-08T09:09:10.000Z', { visibility: 'hidden' });
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  const items = (await call('GET', '/api/glint/photos', null, sam)).body.items;
  const clips = items.filter((p) => /MOV$/.test(p.name) && p.taken >= Date.parse(T) && p.taken <= Date.parse(T2) + 5000);
  for (const c of clips) await fetch(`${base}/api/glint/photos/${c.id}/preview?taken=${c.taken}&dur=1.5`, { method: 'PUT', headers: { Cookie: sam, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]) });
  const after = (await call('GET', '/api/glint/photos', null, sam)).body.items;
  const mine = after.filter((p) => p.taken >= Date.parse(T) && p.taken <= Date.parse(T2) + 5000);
  assert.deepEqual(mine.map((p) => p.name).sort(), ['IMG_0200.HEIC', 'IMG_0201.HEIC']);
  assert.ok(mine.every((p) => p.live));
});

test('a photo that names its video in the app\'s upload is paired with it whatever the names and dates', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const send = (id, name, data, created, extra = {}) => {
    const m = multipart({ deviceAssetId: id, deviceId: 'phone-1', fileCreatedAt: created, fileModifiedAt: created, ...extra }, name, Buffer.from(data), /MOV$/i.test(name) ? 'video/quicktime' : 'image/heic');
    return post('/api/assets', { Authorization: `Bearer ${token}`, 'Content-Type': m.type }, m.body);
  };
  const clip = await send('NAMED_CLIP', 'ABCD_L0_001_999_o_FullSizeRender.mov', 'clip n', '2015-01-02T03:04:05.000Z', { visibility: 'hidden' });
  const still = await send('NAMED_STILL', 'IMG_7777.HEIC', 'still n', '2015-03-04T05:06:07.000Z', { livePhotoVideoId: clip.body.id });
  assert.equal(still.status, 201);
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  const list = (await call('GET', '/api/glint/photos', null, sam)).body.items;
  const photo = list.find((p) => p.name === 'IMG_7777.HEIC');
  assert.ok(photo && photo.live, 'the photo has its clip');
  assert.ok(!list.some((p) => p.name.startsWith('ABCD_L0')), 'the clip is not a tile of its own');
});

test('a Live Photo clip that never found its photo is offered in Clear clutter', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const m = multipart({ deviceAssetId: 'LONELY_CLIP', deviceId: 'phone-1', fileCreatedAt: '2012-02-02T02:02:02.000Z', fileModifiedAt: '2012-02-02T02:02:02.000Z', visibility: 'hidden' }, 'lonely_L0_001.mov', Buffer.from('c'), 'video/quicktime');
  assert.equal((await post('/api/assets', { Authorization: `Bearer ${token}`, 'Content-Type': m.type }, m.body)).status, 201);
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  await call('GET', '/api/glint/photos', null, sam);
  const groups = (await call('GET', '/api/glint/clutter', null, sam)).body.groups;
  const clips = groups.find((g) => g.id === 'clips');
  assert.ok(clips && clips.items.some((i) => i.name === 'lonely_L0_001.mov'));
});

test('a burst of Live Photos sent without links still pairs one clip to one photo by time', async () => {
  const token = (await call('POST', '/api/auth/login', { email: 'sam@roost', password: 'password1' })).body.accessToken;
  const send = (id, name, created, extra = {}) => {
    const m = multipart({ deviceAssetId: id, deviceId: 'phone-1', fileCreatedAt: created, fileModifiedAt: created, ...extra }, name, Buffer.from(id), /MOV$/i.test(name) ? 'video/quicktime' : 'image/heic');
    return post('/api/assets', { Authorization: `Bearer ${token}`, 'Content-Type': m.type }, m.body);
  };
  const base0 = Date.parse('2011-05-05T05:05:05.000Z');
  const at = (ms) => new Date(base0 + ms).toISOString();
  for (let i = 0; i < 3; i++) {
    await send(`BURST_S${i}`, `IMG_90${i}.HEIC`, at(i * 1000));
    await send(`BURST_C${i}`, `ZZ${i}_L0_001.MOV`, at(i * 1000 + 200), { visibility: 'hidden' });
  }
  const sam = (await call('POST', '/api/login', { username: 'sam', password: 'password1' })).cookie;
  const items = (await call('GET', '/api/glint/photos', null, sam)).body.items.filter((p) => /^(IMG_90\d|ZZ\d_)/.test(p.name));
  assert.deepEqual(items.map((p) => p.name).sort(), ['IMG_900.HEIC', 'IMG_901.HEIC', 'IMG_902.HEIC']);
  assert.equal(new Set(items.map((p) => p.live)).size, 3);
});
