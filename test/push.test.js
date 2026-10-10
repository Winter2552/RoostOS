'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Push, encrypt, validEndpoint, vapidHeader, newVapid, deviceLabel } = require('../src/push');
const { createServer } = require('../src/server');
const { GRACE_MS } = require('../src/alerts');
const { setUpTwoStep } = require('./helpers');

const b = (s) => Buffer.from(s, 'base64url');

// A pretend phone: its own keys, like the ones a browser makes when it subscribes.
function fakeDevice(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } },
  };
}

// What the phone does with a message: RFC 8291 from the receiving side.
function decrypt(body, device) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const data = body.subarray(21 + idLen);
  const shared = device.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, device.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'ends with the final-record marker');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

test('encryption matches the example in RFC 8291', () => {
  const as = crypto.createECDH('prime256v1');
  as.setPrivateKey(b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const body = encrypt(
    'When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    { ephemeral: as, salt: b('DGv6ra1nlYgDCS1FRnbzlw') },
  );
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a device can read what Roost encrypts for it, and only that device', () => {
  const phone = fakeDevice();
  const other = fakeDevice();
  const body = encrypt(JSON.stringify({ title: 'Jellyfin has stopped' }), phone.subscription.keys.p256dh, phone.subscription.keys.auth);
  assert.deepEqual(decrypt(body, phone), { title: 'Jellyfin has stopped' });
  assert.throws(() => decrypt(body, other));
  assert.throws(() => encrypt('x', 'AAAA', phone.subscription.keys.auth), /Bad device keys/);
});

test('Roost signs each message with its own key', () => {
  const vapid = newVapid();
  const now = Date.UTC(2026, 9, 10, 12);
  const header = vapidHeader(vapid, 'https://fcm.googleapis.com/fcm/send/abc', 'https://roostos.network', now);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(b(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b(claims)), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://roostos.network' });
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b(vapid.publicKey).subarray(1, 33).toString('base64url'), y: b(vapid.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(sig)));
});

test('only the browsers\' push services are accepted as addresses', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.equal(validEndpoint(ok), true, ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/x',
    'https://evil.example.com/x',
    'https://fcm.googleapis.com.evil.example.com/x',
    'https://user@fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'not a url',
    42,
  ]) assert.equal(validEndpoint(bad), false, String(bad));
});

test('devices get a plain name from the browser', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'), 'iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36'), 'Android');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0'), 'Windows · Edge');
  assert.equal(deviceLabel(''), 'Device');
});

function pushSetup(post) {
  const store = { db: { users: [{ id: 'u1', role: 'admin' }, { id: 'u2', role: 'user' }] }, saves: 0, save() { this.saves++; } };
  const push = new Push({ store, post, isAdmin: (id) => store.db.users.find((u) => u.id === id)?.role === 'admin', wait: async () => {} });
  return { store, push };
}

test('sending: encrypted, signed, and cleaned up when a device is gone', async () => {
  const phone = fakeDevice('https://fcm.googleapis.com/fcm/send/phone');
  const gone = fakeDevice('https://fcm.googleapis.com/fcm/send/gone');
  const sent = [];
  const { store, push } = pushSetup(async (url, headers, body) => {
    sent.push({ url, headers, body });
    return { status: url.endsWith('/gone') ? 410 : 201 };
  });
  push.publicKey();
  push.subscribe('u1', phone.subscription, { userAgent: 'Mozilla/5.0 (iPhone)', host: 'roostos.network' });
  push.subscribe('u1', gone.subscription, { userAgent: 'Mozilla/5.0 (Android)', host: 'roostos.network' });

  const result = await push.sendAll(push.devicesOf('u1'), { title: 'Hello' }, { ttl: 600, urgency: 'normal' });
  assert.deepEqual(result, { sent: 1, failed: 0, removed: 1 });
  assert.deepEqual(push.devicesOf('u1').map((d) => d.label), ['iPhone']);

  const toPhone = sent.find((s) => s.url.endsWith('/phone'));
  assert.deepEqual(decrypt(toPhone.body, phone), { title: 'Hello' });
  assert.equal(toPhone.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(toPhone.headers.TTL, '600');
  assert.equal(toPhone.headers.Urgency, 'normal');
  assert.match(toPhone.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.ok(store.saves >= 3, 'the removal was saved');
});

test('a push service hiccup is retried once, then reported', async () => {
  const phone = fakeDevice();
  let calls = 0;
  const { push } = pushSetup(async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return { status: calls < 4 ? 503 : 201 };
  });
  push.publicKey();
  push.subscribe('u1', phone.subscription, { host: 'roostos.network' });
  assert.deepEqual(await push.sendAll(push.devicesOf('u1'), { title: 'x' }), { sent: 0, failed: 1, removed: 0 });
  assert.equal(calls, 2);
  assert.equal(push.devicesOf('u1').length, 1, 'a hiccup does not forget the device');
});

test('subscribing checks the address and keys, refreshes repeats and caps devices', () => {
  const { store, push } = pushSetup(async () => ({ status: 201 }));
  const phone = fakeDevice();
  assert.throws(() => push.subscribe('u1', { endpoint: 'https://evil.example.com/x', keys: phone.subscription.keys }), /push address/);
  assert.throws(() => push.subscribe('u1', { endpoint: phone.subscription.endpoint, keys: { p256dh: 'AAAA', auth: 'AAAA' } }), /keys look wrong/);
  const a = push.subscribe('u1', phone.subscription, { userAgent: 'Windows Chrome/1' });
  const saves = store.saves;
  const again = push.subscribe('u1', phone.subscription, { userAgent: 'Windows Chrome/1' });
  assert.equal(a.id, again.id);
  assert.equal(store.saves, saves, 'sending the same device again writes nothing');
  assert.equal(push.devicesOf('u1').length, 1);
  for (let i = 0; i < 19; i++) push.subscribe('u1', fakeDevice(`https://fcm.googleapis.com/fcm/send/${i}`).subscription);
  assert.throws(() => push.subscribe('u1', fakeDevice('https://fcm.googleapis.com/fcm/send/extra').subscription), /Remove a device/);
  assert.equal(push.remove(a.id, 'u2'), false, 'only the owner can remove a device');
  assert.equal(push.remove(a.id, 'u1'), true);
});

test('alerts: raised and cleared go to admins, ignored and self-heal notes do not', async () => {
  const phone = fakeDevice('https://fcm.googleapis.com/fcm/send/admin');
  const userPhone = fakeDevice('https://fcm.googleapis.com/fcm/send/user');
  const sent = [];
  const { push } = pushSetup(async (url, headers, body) => {
    sent.push({ url, body });
    return { status: 201 };
  });
  push.publicKey();
  push.subscribe('u1', phone.subscription, { host: 'roostos.network' });
  // Someone who isn't an admin (any more) gets nothing.
  push.subscribe('u2', userPhone.subscription, { host: 'roostos.network' });

  push.alert('raised', { key: 'app:jellyfin', title: 'Jellyfin has stopped', detail: 'jellyfin · exit code 137', okTitle: 'Jellyfin is back' });
  await push.idle();
  assert.equal(sent.length, 1);
  assert.deepEqual(decrypt(sent[0].body, phone), { title: 'Jellyfin has stopped', body: 'jellyfin · exit code 137', tag: 'app:jellyfin', url: '/#/status' });

  push.alert('resolved', { key: 'app:jellyfin', title: 'Jellyfin has stopped', detail: 'x', okTitle: 'Jellyfin is back' });
  await push.idle();
  assert.deepEqual(decrypt(sent[1].body, phone), { title: 'Jellyfin is back', body: 'The problem has cleared.', tag: 'app:jellyfin', url: '/#/status' });

  push.alert('resolved', { key: 'app:nova', title: 'Nova is unhealthy', okTitle: 'Nova is healthy again', dismissedAt: 'x' });
  push.alert('event', { key: 'restart:nova', title: 'Nova restarted on its own' });
  await push.idle();
  assert.equal(sent.length, 2);
});

test('phone alerts: the whole path through the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-push-'));
  const docker = { containers: [{ id: 'c1', name: 'jellyfin', project: '', state: 'running', health: null, restarts: 0, exitCode: null }] };
  const sent = [];
  const server = createServer({
    dataDir: dir,
    alertIntervalMs: 0,
    disks: [{ label: 'Data', path: dir }],
    readContainers: async () => docker,
    push: { post: async (url, headers, body) => { sent.push({ url, headers, body }); return { status: 201 }; }, wait: async () => {} },
  });
  let clock = Date.now();
  server.watcher.now = () => clock;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie, headers = {}) => {
    const res = await fetch(url + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, admin);
    // The temp folder's drive could be nearly full on any machine; keep this test about apps.
    await call('PATCH', '/api/admin/settings', { alertDisks: false }, admin);
    await call('POST', '/api/admin/users', { username: 'sam', password: 'correct horse' }, admin);
    const sam = (await call('POST', '/api/login', { username: 'sam', password: 'correct horse' })).cookie;
    for (const [method, p] of [['GET', '/api/push/key'], ['GET', '/api/push/devices'], ['POST', '/api/push/test']]) {
      assert.equal((await call(method, p, method === 'POST' ? {} : null, sam)).status, 403, p);
    }

    // The browser asks for Roost's key, then hands over what it subscribed with.
    const key = (await call('GET', '/api/push/key', null, admin)).body.publicKey;
    assert.equal(b(key).length, 65);
    assert.equal((await call('GET', '/api/push/key', null, admin)).body.publicKey, key, 'the key is made once');
    assert.equal((await call('POST', '/api/push/test', {}, admin)).status, 400, 'nothing to test yet');

    const phone = fakeDevice();
    const bad = await call('POST', '/api/push/devices', { subscription: { ...phone.subscription, endpoint: 'https://evil.example.com/x' } }, admin);
    assert.equal(bad.status, 400);
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
    const added = await call('POST', '/api/push/devices', { subscription: phone.subscription }, admin, { 'User-Agent': iphone });
    assert.equal(added.status, 200);
    assert.equal(added.body.device.label, 'iPhone');
    assert.deepEqual(Object.keys(added.body.device).sort(), ['createdAt', 'id', 'label']);
    assert.deepEqual((await call('GET', '/api/push/devices', null, admin)).body.devices.map((d) => d.id), [added.body.device.id]);
    assert.deepEqual((await call('GET', '/api/push/devices', null, sam)).body, { error: 'Admins only' });
    // Only the key and devices of this person are shown, never the private key.
    assert.ok(!JSON.stringify((await call('GET', '/api/admin/settings', null, admin)).body).includes('privateKey'));

    // The setup checklist notices.
    const step = async () => (await call('GET', '/api/admin/setup', null, admin)).body.steps.find((s) => s.id === 'phone-alerts');
    assert.equal((await step()).done, true);

    // A test alert reaches the phone.
    const test = await call('POST', '/api/push/test', {}, admin);
    assert.deepEqual(test.body.result, { sent: 1, failed: 0, removed: 0 });
    assert.equal(decrypt(sent[0].body, phone).title, 'Roost alerts are on');

    // A real one: Jellyfin stops, and two minutes later the phone hears of it once.
    sent.length = 0;
    await server.watcher.check();
    docker.containers[0].state = 'exited';
    await server.watcher.check();
    clock += GRACE_MS + 1000;
    await server.watcher.check();
    await server.push.idle();
    assert.deepEqual(sent.map((s) => decrypt(s.body, phone).title), ['Jellyfin has stopped']);
    await server.watcher.check();
    await server.push.idle();
    assert.equal(sent.length, 1, 'no repeat while it stays stopped');

    docker.containers[0].state = 'running';
    await server.watcher.check();
    await server.push.idle();
    assert.deepEqual(sent.map((s) => decrypt(s.body, phone).title), ['Jellyfin has stopped', 'Jellyfin is back']);

    // Someone no longer an admin stops getting alerts.
    sent.length = 0;
    const db = server.push.store.db;
    db.users.find((u) => u.username === 'raven').role = 'user';
    server.push.alert('raised', { key: 'k', title: 't', detail: 'd' });
    await server.push.idle();
    assert.equal(sent.length, 0);
    db.users.find((u) => u.username === 'raven').role = 'admin';

    // Turning alerts off removes the device and unticks the step.
    const removed = await call('DELETE', `/api/push/devices/${added.body.device.id}`, null, admin);
    assert.deepEqual(removed.body.devices, []);
    assert.equal((await call('DELETE', `/api/push/devices/${added.body.device.id}`, null, admin)).status, 404);
    assert.equal((await step()).done, false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs public/sw.js against a pretend browser, to check what it shows and where a tap goes.
function loadServiceWorker() {
  const handlers = {};
  const shown = [];
  const opened = [];
  const windows = [];
  const self = {
    location: { origin: 'https://roostos.network' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, ...options }); } },
    clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url); } },
  };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), { self, URL, Request: class {}, Response: class {}, caches: {}, fetch() {} });
  const run = async (type, event) => {
    let pending;
    await handlers[type]({ waitUntil: (p) => { pending = p; }, ...event });
    await pending;
  };
  return { run, shown, opened, windows };
}

test('the service worker shows each alert, replacing the one with the same tag', async () => {
  const sw = loadServiceWorker();
  await sw.run('push', { data: { json: () => ({ title: 'Jellyfin has stopped', body: 'jellyfin · exit code 137', tag: 'app:jellyfin', url: '/#/status' }) } });
  assert.deepEqual(sw.shown, [{ title: 'Jellyfin has stopped', body: 'jellyfin · exit code 137', tag: 'app:jellyfin', icon: '/icons/icon-192.png', data: { url: '/#/status' } }]);
  // Something odd still shows a notification (browsers insist), and never sends a tap elsewhere.
  await sw.run('push', { data: { json: () => ({ title: 'x', url: 'https://evil.example.com' }) } });
  assert.equal(sw.shown[1].data.url, '/');
  await sw.run('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'plain words' } });
  assert.deepEqual([sw.shown[2].title, sw.shown[2].body], ['Roost', 'plain words']);
  await sw.run('push', {});
  assert.equal(sw.shown[3].title, 'Roost');
});

test('tapping an alert brings Roost forward at the status page', async () => {
  const sw = loadServiceWorker();
  let closed = 0;
  const tap = { notification: { close: () => { closed++; }, data: { url: '/#/status' } } };
  await sw.run('notificationclick', tap);
  assert.deepEqual(sw.opened, ['/#/status'], 'opens Roost when it is not open');

  const win = { url: 'https://roostos.network/#/apps', focused: 0, went: [], focus: async () => { win.focused++; }, navigate: async (u) => { win.went.push(u); } };
  sw.windows.push({ url: 'https://other.example.com/', focus: async () => { throw new Error('wrong window'); } }, win);
  await sw.run('notificationclick', tap);
  assert.equal(sw.opened.length, 1, 'an open window is reused');
  assert.deepEqual([win.focused, win.went], [1, ['/#/status']]);
  assert.equal(closed, 2);
});
