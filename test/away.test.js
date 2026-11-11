'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const away = require('../src/away');
const wireguard = require('../src/wireguard');
const { qrMatrix } = require('../src/qr');
const { createServer } = require('../src/server');
const { setUpTwoStep } = require('./helpers');

test('the home network must be a private range, and the tunnel\'s own range is refused', () => {
  assert.equal(away.cleanLan('192.168.4.0/24'), '192.168.4.0/24');
  assert.equal(away.cleanLan('192.168.4.77/24'), '192.168.4.0/24');
  assert.equal(away.cleanLan('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(away.cleanLan('172.20.1.0/24'), '172.20.1.0/24');
  for (const bad of ['8.8.8.0/24', '172.32.0.0/16', '192.168.4.0', '192.168.4.0/0', '192.168.4.0/32', '10.78.0.0/24', '300.1.1.1/24', '', 'x']) assert.equal(away.cleanLan(bad), null, bad);
});

test('the address is a plain name or IP, never a path or port', () => {
  assert.equal(away.cleanHost(' Away.Roostos.Network '), 'away.roostos.network');
  assert.equal(away.cleanHost('141.147.108.43'), '141.147.108.43');
  for (const bad of ['a b', 'x/y', 'host:51821', '-bad', 'bad-', '']) assert.equal(away.cleanHost(bad), null, bad);
});

test('device addresses are handed out in order and reused after a removal', () => {
  assert.equal(away.nextAddress([]), '10.78.0.2');
  assert.equal(away.nextAddress([{ address: '10.78.0.2' }, { address: '10.78.0.4' }]), '10.78.0.3');
});

test('the server config lists each device by its public key only, and passes traffic on to the home network', () => {
  const keys = wireguard.makeKeys();
  const text = away.serverConfig({ privateKey: keys.privateKey, devices: [{ name: 'Phone\nPostUp = evil', publicKey: keys.publicKey, address: '10.78.0.2' }] });
  assert.match(text, /ListenPort = 51821/);
  assert.match(text, /MASQUERADE/);
  assert.match(text, new RegExp(`PublicKey = ${keys.publicKey.replace(/\+/g, '\\+')}\\nAllowedIPs = 10\\.78\\.0\\.2/32`));
  // A device name can't smuggle in a config line.
  assert.equal(text.split('\n').filter((l) => l.startsWith('PostUp')).length, 1);
});

test('a device config only routes the home network and the tunnel, and fits a QR code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-away-'));
  try {
    const a = new away.Away(dir);
    const made = a.newDevice([], { host: 'away.roostos.network', lan: '192.168.4.0/24' });
    assert.match(made.config, /AllowedIPs = 192\.168\.4\.0\/24, 10\.78\.0\.0\/24/);
    assert.match(made.config, /Endpoint = away\.roostos\.network:51821/);
    assert.ok(!/DNS|0\.0\.0\.0\/0/.test(made.config));
    assert.ok(Buffer.byteLength(made.config) < 331, `config is ${Buffer.byteLength(made.config)} bytes`);
    const m = qrMatrix(made.config);
    assert.ok(m.length >= 61 && m.length <= 69, `size ${m.length}`);
    // Its public key matches the private key in the config.
    const priv = /PrivateKey = (\S+)/.exec(made.config)[1];
    assert.equal(wireguard.publicOf(priv), made.publicKey);
    // The server's key is made once and reused.
    assert.equal(a.publicKey(), a.publicKey());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the QR encoder reaches versions 11 to 13', () => {
  assert.equal(qrMatrix('x'.repeat(214)).length, 61);
  assert.equal(qrMatrix('x'.repeat(252)).length, 65);
  assert.equal(qrMatrix('x'.repeat(288)).length, 69);
  assert.equal(qrMatrix('x'.repeat(331)).length, 69);
  assert.throws(() => qrMatrix('x'.repeat(332)));
});

test('apply brings the link down with no config, and explains a missing tool or permission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-away-'));
  try {
    const calls = [];
    let fail = null;
    const a = new away.Away(dir, { run: (cmd, args, opts, cb) => { calls.push(`${cmd} ${args[0]}`); cb(args[0] === 'up' ? fail : null, '', fail ? fail.stderr || '' : ''); } });
    a.write({ enabled: false, devices: [] });
    assert.deepEqual(await a.apply(), { ok: true, note: 'Away from home is off' });
    a.write({ enabled: true, devices: [] });
    assert.equal((await a.apply()).ok, true);
    assert.deepEqual(calls.slice(-2), ['wg-quick down', 'wg-quick up']);
    fail = Object.assign(new Error('x'), { code: 'ENOENT' });
    assert.match((await a.apply()).note, /no WireGuard tools/);
    fail = Object.assign(new Error('x'), { stderr: 'RTNETLINK answers: Operation not permitted' });
    assert.match((await a.apply()).note, /NET_ADMIN/);
    fail = Object.assign(new Error('x'), { stderr: 'iptables: Table does not exist' });
    assert.match((await a.apply()).note, /iptables/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- through the server ----------

let server;
let base;
let dataDir;
let admin;
const calls = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-away-srv-'));
  const peerKey = wireguard.makeKeys().publicKey;
  server = createServer({
    dataDir,
    probeTimeoutMs: 200,
    dockerHost: 'tcp://127.0.0.1:1',
    awayOptions: {
      run: (cmd, args, opts, cb) => {
        calls.push(`${cmd} ${args.join(' ')}`.trim());
        cb(null, args[0] === 'show' ? `${peerKey}\t1700000000\n` : '', '');
      },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
  await setUpTwoStep(call, admin);
  await call('POST', '/api/admin/users', { username: 'mia', password: 'password1' }, admin);
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

test('only admins can see or change Away from home', async () => {
  const mia = (await call('POST', '/api/login', { username: 'mia', password: 'password1' })).cookie;
  for (const [m, u] of [['GET', '/api/admin/away'], ['PUT', '/api/admin/away'], ['POST', '/api/admin/away/devices'], ['DELETE', '/api/admin/away/devices/x']]) {
    const body = m === 'GET' || m === 'DELETE' ? null : {};
    assert.equal((await call(m, u, body)).status, 401, `${m} ${u} signed out`);
    assert.equal((await call(m, u, body, mia)).status, 403, `${m} ${u} as a member`);
  }
});

test('it starts off, needs an address, and refuses devices until it is on', async () => {
  const off = await call('GET', '/api/admin/away', null, admin);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.lan, '192.168.4.0/24');
  assert.deepEqual(off.body.devices, []);
  assert.equal((await call('PUT', '/api/admin/away', { enabled: true }, admin)).status, 400); // no domain, no address
  assert.equal((await call('PUT', '/api/admin/away', { enabled: true, host: 'bad host' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/admin/away', { enabled: true, host: 'home.example.com', lan: '8.8.8.0/24' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/admin/away/devices', { name: 'Phone' }, admin)).status, 400);
});

test('turning it on writes the server config and brings the link up', async () => {
  const on = await call('PUT', '/api/admin/away', { enabled: true, host: 'home.example.com', lan: '192.168.4.0/24' }, admin);
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.applied.ok, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'wireguard', 'wg1.conf')));
  assert.ok(calls.includes(`wg-quick up ${path.join(dataDir, 'wireguard', 'wg1.conf')}`));
  assert.equal(fs.statSync(path.join(dataDir, 'wireguard', 'wg1.conf')).mode & 0o077, 0);
});

test('adding a device returns its config and QR once and keeps only its public key', async () => {
  assert.equal((await call('POST', '/api/admin/away/devices', { name: '  ' }, admin)).status, 400);
  const added = await call('POST', '/api/admin/away/devices', { name: 'Raven iPhone' }, admin);
  assert.equal(added.status, 200);
  const { config, qr, id } = added.body.added;
  assert.match(config, /Endpoint = home\.example\.com:51821/);
  assert.match(qr, /^<svg/);
  const priv = /PrivateKey = (\S+)/.exec(config)[1];
  assert.equal(added.body.devices.length, 1);
  assert.equal(added.body.devices[0].address, '10.78.0.2');
  // The private key is in neither the saved settings nor the server's config.
  assert.ok(!fs.readFileSync(path.join(dataDir, 'wireguard', 'wg1.conf'), 'utf8').includes(priv));
  for (const f of fs.readdirSync(dataDir)) {
    const p = path.join(dataDir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(priv), `${f} must not hold the device key`);
  }
  assert.ok(!JSON.stringify((await call('GET', '/api/admin/settings', null, admin)).body).includes('devices'));
  const second = await call('POST', '/api/admin/away/devices', { name: 'Windows PC' }, admin);
  assert.equal(second.body.devices[1].address, '10.78.0.3');
  assert.ok(second.body.devices[0].lastSeen === null || typeof second.body.devices[0].lastSeen === 'number');
  assert.equal(id.length, 12);
});

test('removing a device takes its peer out of the server config', async () => {
  const list = (await call('GET', '/api/admin/away', null, admin)).body.devices;
  const gone = await call('DELETE', `/api/admin/away/devices/${list[0].id}`, null, admin);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.devices.map((d) => d.name), ['Windows PC']);
  const conf = fs.readFileSync(path.join(dataDir, 'wireguard', 'wg1.conf'), 'utf8');
  assert.equal(conf.split('[Peer]').length - 1, 1);
  assert.equal((await call('DELETE', '/api/admin/away/devices/nope', null, admin)).status, 404);
});

test('turning it off removes the config', async () => {
  const off = await call('PUT', '/api/admin/away', { enabled: false }, admin);
  assert.equal(off.body.enabled, false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'wireguard', 'wg1.conf')));
  assert.equal((await call('POST', '/api/admin/away/devices', { name: 'Phone' }, admin)).status, 400);
});
