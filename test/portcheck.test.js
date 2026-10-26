'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { checkPorts } = require('../src/portcheck');
const { securityChecks } = require('../src/security');
const { setUpTwoStep } = require('./helpers');

const listen = () => new Promise((resolve) => {
  const s = net.createServer((c) => c.end());
  s.listen(0, '127.0.0.1', () => resolve(s));
});

test('open ports are found, closed ones are not', async () => {
  const open = await listen();
  const shut = await listen();
  const openPort = open.address().port;
  const shutPort = shut.address().port;
  await new Promise((r) => shut.close(r));
  const out = await checkPorts('127.0.0.1', { timeoutMs: 500, now: () => 5, ports: [{ port: openPort, name: 'test' }, { port: shutPort, name: 'gone' }] });
  open.close();
  assert.deepEqual(out, { ip: '127.0.0.1', at: 5, tried: 2, open: [{ port: openPort, name: 'test' }] });
});

test('the checklist wants only 443 open', () => {
  const base = { db: { users: [], settings: {} } };
  const at = Date.parse('2026-10-26T12:00:00Z');
  const none = securityChecks(base).checks.find((c) => c.id === 'ports');
  assert.equal(none.status, 'info');
  const fine = securityChecks({ ...base, ports: { ip: '1.2.3.4', at, tried: 18, open: [{ port: 443, name: 'Roost (HTTPS)' }] } }).checks.find((c) => c.id === 'ports');
  assert.equal(fine.status, 'ok');
  const bad = securityChecks({ ...base, ports: { ip: '1.2.3.4', at, tried: 18, open: [{ port: 443, name: 'x' }, { port: 22, name: 'SSH' }] } }).checks.find((c) => c.id === 'ports');
  assert.equal(bad.status, 'bad');
  assert.match(bad.detail, /22 \(SSH\)/);
});

test('the button checks the public address, for admins, at most once a minute', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-ports-'));
  const open = await listen();
  const server = createServer({
    dataDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1',
    remoteOptions: { fetchImpl: async () => ({ text: async () => 'ip=127.0.0.1\n' }) },
    portOptions: { timeoutMs: 500, ports: [{ port: open.address().port, name: 'Mystery' }] },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json().catch(() => null), cookie: set && set.split(';')[0] };
  };
  try {
    assert.equal((await call('POST', '/api/admin/security/ports')).status, 401);
    const cookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie;
    await setUpTwoStep(call, cookie);
    const ran = await call('POST', '/api/admin/security/ports', null, cookie);
    assert.equal(ran.status, 200);
    assert.equal(ran.body.ports.open[0].name, 'Mystery');
    assert.equal((await call('POST', '/api/admin/security/ports', null, cookie)).status, 429);
    const view = (await call('GET', '/api/admin/security', null, cookie)).body;
    assert.equal(view.checks.find((c) => c.id === 'ports').status, 'bad');
  } finally {
    server.close();
    open.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
