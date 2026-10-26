'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync, spawnSync } = require('child_process');
const { createServer } = require('../src/server');
const { recover, report, tempPassword } = require('../src/recover');
const { Sentinel } = require('../src/sentinel');
const { hashPassword, verifyPassword } = require('../src/auth');

// A data folder the way a compromised Roost might leave it.
function dirty() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-recover-'));
  const db = {
    version: 1,
    settings: {
      serverName: 'Roost', adminsNeedTwoStep: false,
      tls: { domain: 'roostos.network', email: 'a@b.c', token: 'cf-secret' },
      mail: { host: 'smtp.resend.com', port: 587, from: 'server@roostos.network', password: 'mail-secret' },
      jellyfin: { url: 'http://x', apiKey: 'jf-secret' },
      coffee: { enabled: true, secret: 'a'.repeat(64) },
      galaxies: [{ id: 'g1', name: 'Test', enabled: true, secret: 'b'.repeat(64) }],
    },
    users: [
      { id: 'u1', username: 'raven', role: 'admin', password: hashPassword('old-password'), twoStep: { secret: 'x', recovery: [] }, trusted: [{ hash: 'h', expires: 9e15 }] },
      { id: 'u2', username: 'evil', role: 'admin', password: hashPassword('attacker'), twoStep: { secret: 'y', recovery: [] } },
      { id: 'u3', username: 'dana', role: 'member', password: hashPassword('dana-pass'), twoStep: { secret: 'z', recovery: [] }, trusted: [{ hash: 'h', expires: 9e15 }] },
    ],
    apps: [],
    links: [{ kind: 'invite', tokenHash: 'x' }],
    push: { vapid: { publicKey: 'p', privateKey: 'k' }, devices: [{ id: 'd' }] },
  };
  fs.writeFileSync(path.join(dir, 'roost.json'), JSON.stringify(db));
  fs.writeFileSync(path.join(dir, 'sessions.json'), '[]');
  fs.mkdirSync(path.join(dir, 'wireguard'));
  fs.writeFileSync(path.join(dir, 'wireguard', 'privatekey'), 'key');
  fs.mkdirSync(path.join(dir, 'tls'));
  for (const f of ['key.pem', 'cert.pem', 'account.pem']) fs.writeFileSync(path.join(dir, 'tls', f), 'pem');
  const nest = new DatabaseSync(path.join(dir, 'nest.db'));
  nest.exec('CREATE TABLE shares (token TEXT PRIMARY KEY, owner TEXT, node TEXT, created INTEGER, expires INTEGER, pass TEXT, downloads INTEGER DEFAULT 0)');
  nest.exec("INSERT INTO shares (token, owner, node, created, expires) VALUES ('t1','u1','n',1,2), ('t2','u3','n',1,2)");
  nest.close();
  return dir;
}

test('recovery resets what an attacker could still use', () => {
  const dir = dirty();
  const out = recover({ dataDir: dir, admin: 'Raven', now: new Date('2026-10-26T12:00:00') });
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'roost.json'), 'utf8'));
  const by = Object.fromEntries(db.users.map((u) => [u.username, u]));

  // Only the chosen admin can get back in, with the temporary password, and must redo two-step.
  assert.ok(verifyPassword(out.password, by.raven.password));
  assert.equal(verifyPassword('old-password', by.raven.password), false);
  assert.equal(verifyPassword('attacker', by.evil.password), false);
  assert.equal(by.raven.twoStep, undefined);
  assert.equal(by.evil.twoStep, undefined);
  assert.equal(db.settings.adminsNeedTwoStep, true);
  // Members keep their password and their authenticator, but not trusted devices.
  assert.ok(verifyPassword('dana-pass', by.dana.password));
  assert.ok(by.dana.twoStep);
  assert.deepEqual(by.dana.trusted, []);

  assert.deepEqual(db.links, []);
  assert.equal(db.push, undefined);
  assert.equal(db.settings.tls.token, undefined);
  assert.equal(db.settings.tls.domain, 'roostos.network');
  assert.equal(db.settings.mail.password, '');
  assert.equal(db.settings.jellyfin.apiKey, '');
  assert.equal(db.settings.coffee.secret, '');
  assert.equal(db.settings.coffee.enabled, false);
  assert.equal(db.settings.galaxies[0].secret, '');
  assert.equal(db.settings.galaxies[0].enabled, false);
  assert.equal(db.settings.lockdown.by, 'Recovery');

  for (const f of ['sessions.json', 'wireguard/privatekey', 'tls/key.pem', 'tls/cert.pem', 'tls/account.pem']) assert.equal(fs.existsSync(path.join(dir, f)), false, f);
  const nest = new DatabaseSync(path.join(dir, 'nest.db'));
  assert.equal(nest.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 0);
  nest.close();
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('roost.json.before-recover-')), 'the old accounts file is kept');

  // Sentinel sees the new accounts as the sealed ones, not as tampering.
  const raised = [];
  const sentinel = new Sentinel({ dataDir: dir, store: { db }, raise: (k, t) => raised.push(t) });
  sentinel.checkSeal();
  assert.deepEqual(raised, []);

  const text = report(out);
  assert.match(text, new RegExp(out.password));
  assert.doesNotMatch(report(out, { withPassword: false }), new RegExp(out.password));
  assert.match(text, /Cloudflare API token/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('public Nest links can be kept, and the admin must be a real admin', () => {
  const dir = dirty();
  assert.throws(() => recover({ dataDir: dir, admin: 'dana' }), /not an admin here/);
  assert.throws(() => recover({ dataDir: dir, admin: '' }), /not an admin here/);
  assert.throws(() => recover({ dataDir: path.join(dir, 'nowhere'), admin: 'raven' }), /No roost.json/);
  const out = recover({ dataDir: dir, admin: 'raven', keepLinks: true });
  const nest = new DatabaseSync(path.join(dir, 'nest.db'));
  assert.equal(nest.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 2);
  nest.close();
  assert.ok(out.byHand.some((t) => /public Nest links/.test(t)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('temporary passwords are readable and different each time', () => {
  const a = tempPassword();
  assert.match(a, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.notEqual(a, tempPassword());
});

test('after recovery the chosen admin can sign in, sets up two-step, and others cannot', async () => {
  const dir = dirty();
  const out = recover({ dataDir: dir, admin: 'raven' });
  const server = createServer({ dataDir: dir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    assert.equal((await login('evil', 'attacker')).status, 401);
    assert.equal((await login('raven', 'old-password')).status, 401);
    const ok = await login('raven', out.password);
    assert.equal(ok.status, 200);
    const sec = await fetch(`${base}/api/admin/security`, { headers: { Cookie: ok.cookie } });
    assert.equal(sec.status, 403); // two-step must be set up first
    // Members still sign in with their own password (and their own authenticator).
    assert.equal((await login('dana', 'dana-pass')).body.twoStep, true);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command asks for an admin and prints the way back in', () => {
  const dir = dirty();
  const script = path.join(__dirname, '..', 'src', 'recover.js');
  const bare = spawnSync('node', [script], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /Usage/);
  const out = execFileSync('node', [script, '--admin', 'raven', '--yes'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /Temporary password: [a-z2-9-]{19}/);
  const saved = fs.readFileSync(path.join(dir, 'recovery-report.txt'), 'utf8');
  assert.doesNotMatch(saved, /Temporary password: [a-z2-9]{4}-/);
  assert.match(saved, /What only you can do/);
  fs.rmSync(dir, { recursive: true, force: true });
});
