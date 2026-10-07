'use strict';

// Gets a certificate end to end against a fake Let's Encrypt and a fake
// Cloudflare. The fake CA signs with the openssl command line, which also
// checks Roost's certificate request is well formed.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { createServer } = require('../src/server');
const { createCsr, newKey, dnsTxtValue } = require('../src/acme');
const twoStep = require('../src/twostep');

let hasOpenssl = true;
try { execFileSync('openssl', ['version']); } catch { hasOpenssl = false; }

let tmp;
let caKey;
let caCert;
let acme;
let acmeBase;
let cf;
let cfBase;
const dns = new Map(); // id -> { name, content }
let cfToken = 'cf-good';
let failChallenges = false;

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function fakeAcme() {
  const accounts = new Map(); // kid -> jwk
  const orders = new Map();
  const nonces = new Set();
  let n = 0;
  const nonce = () => { const v = `nonce-${++n}`; nonces.add(v); return v; };

  return http.createServer((req, res) => handle(req, res).catch((err) => {
    res.writeHead(500, { 'Replay-Nonce': nonce() });
    res.end(JSON.stringify({ detail: `fake CA broke: ${err.message}` }));
  }));

  async function handle(req, res) {
    const base = acmeBase;
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'Replay-Nonce': nonce(), 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/dir') {
      return reply(200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
    }
    if (req.url === '/nonce') return reply(200, '');

    const jws = JSON.parse(await readBody(req));
    const header = b64json(jws.protected);
    if (!nonces.delete(header.nonce)) return reply(400, { type: 'urn:ietf:params:acme:error:badNonce', detail: 'bad nonce' });
    if (header.url !== base + req.url) return reply(400, { type: 'urn:ietf:params:acme:error:malformed', detail: 'url mismatch' });
    const jwk = header.jwk || accounts.get(header.kid);
    if (!jwk) return reply(400, { type: 'urn:ietf:params:acme:error:accountDoesNotExist', detail: 'no account' });
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const okSig = crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
    if (!okSig) return reply(400, { type: 'urn:ietf:params:acme:error:malformed', detail: 'bad signature' });
    const payload = jws.payload ? b64json(jws.payload) : undefined;

    if (req.url === '/account') {
      assert.equal(payload.termsOfServiceAgreed, true);
      const kid = `${base}/acct/1`;
      accounts.set(kid, jwk);
      return reply(201, { status: 'valid' }, { Location: kid });
    }
    if (req.url === '/order') {
      const id = String(orders.size + 1);
      const order = {
        status: 'pending',
        identifiers: payload.identifiers,
        authorizations: payload.identifiers.map((_, i) => `${base}/authz/${id}/${i}`),
        finalize: `${base}/finalize/${id}`,
        authz: payload.identifiers.map((ident, i) => ({ ident, status: 'pending', token: `tok${id}${i}`, jwk })),
      };
      orders.set(id, order);
      const { authz, ...pub } = order;
      return reply(201, pub, { Location: `${base}/orders/${id}` });
    }
    let m;
    if ((m = req.url.match(/^\/authz\/(\d+)\/(\d+)$/))) {
      const a = orders.get(m[1]).authz[m[2]];
      return reply(200, {
        status: a.status,
        identifier: { type: 'dns', value: a.ident.value.replace(/^\*\./, '') },
        challenges: [
          { type: 'http-01', url: `${base}/chall/${m[1]}/${m[2]}/http`, token: a.token },
          { type: 'dns-01', url: `${base}/chall/${m[1]}/${m[2]}`, token: a.token },
        ],
        ...(a.status === 'invalid' ? { challenges: [{ type: 'dns-01', error: { detail: 'No TXT record found' } }] } : {}),
      });
    }
    if ((m = req.url.match(/^\/chall\/(\d+)\/(\d+)$/))) {
      const order = orders.get(m[1]);
      const a = order.authz[m[2]];
      const name = `_acme-challenge.${a.ident.value.replace(/^\*\./, '')}`;
      const want = dnsTxtValue(a.token, crypto.createPublicKey({ key: a.jwk, format: 'jwk' }));
      const found = [...dns.values()].some((r) => r.name === name && r.content === want);
      a.status = found && !failChallenges ? 'valid' : 'invalid';
      if (order.authz.every((x) => x.status === 'valid')) order.status = 'ready';
      if (a.status === 'invalid') order.status = 'invalid';
      return reply(200, { status: 'processing' });
    }
    if ((m = req.url.match(/^\/orders\/(\d+)$/))) {
      const { authz, ...pub } = orders.get(m[1]);
      return reply(200, pub);
    }
    if ((m = req.url.match(/^\/finalize\/(\d+)$/))) {
      const order = orders.get(m[1]);
      const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from(payload.csr, 'base64url').toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
      const csrFile = path.join(tmp, `req${m[1]}.csr`);
      fs.writeFileSync(csrFile, csrPem);
      const ext = path.join(tmp, 'ext.cnf');
      fs.writeFileSync(ext, `subjectAltName=${order.identifiers.map((i) => `DNS:${i.value}`).join(',')}\n`);
      order.pem = execFileSync('openssl', ['x509', '-req', '-in', csrFile, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', '90', '-extfile', ext]).toString();
      order.status = 'valid';
      order.certificate = `${acmeBase}/cert/${m[1]}`;
      const { authz, pem, ...pub } = order;
      return reply(200, pub);
    }
    if ((m = req.url.match(/^\/cert\/(\d+)$/))) {
      return reply(200, orders.get(m[1]).pem, { 'Content-Type': 'application/pem-certificate-chain' });
    }
    reply(404, { detail: 'not found' });
  }
}

function fakeCloudflare() {
  let next = 0;
  return http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${cfToken}`) return json(403, { success: false, errors: [{ message: 'Authentication error' }] });
    const body = await readBody(req);
    if (req.method === 'GET' && req.url.startsWith('/zones?name=')) {
      const name = decodeURIComponent(req.url.split('=')[1]);
      return json(200, { success: true, result: name === 'roostos.network' ? [{ id: 'zone1' }] : [] });
    }
    if (req.method === 'POST' && req.url === '/zones/zone1/dns_records') {
      const rec = JSON.parse(body);
      const id = `rec${++next}`;
      dns.set(id, rec);
      return json(200, { success: true, result: { id } });
    }
    let m;
    if (req.method === 'DELETE' && (m = req.url.match(/^\/zones\/zone1\/dns_records\/(\w+)$/))) {
      dns.delete(m[1]);
      return json(200, { success: true, result: { id: m[1] } });
    }
    json(404, { success: false, errors: [{ message: 'not found' }] });
  });
}

let server;
let base;
let adminCookie;

async function call(method, url, body) {
  const headers = { Cookie: adminCookie || '' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-tls-'));
  if (hasOpenssl) {
    caKey = path.join(tmp, 'ca.key');
    caCert = path.join(tmp, 'ca.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '1', '-subj', '/O=Fake Encrypt/CN=Fake CA'], { stdio: 'ignore' });
  }
  acme = fakeAcme();
  cf = fakeCloudflare();
  await new Promise((r) => acme.listen(0, '127.0.0.1', r));
  await new Promise((r) => cf.listen(0, '127.0.0.1', r));
  acmeBase = `http://127.0.0.1:${acme.address().port}`;
  cfBase = `http://127.0.0.1:${cf.address().port}`;
  server = createServer({
    dataDir: path.join(tmp, 'data'),
    trustProxy: true,
    tls: { directoryUrl: `${acmeBase}/dir`, cloudflareApi: cfBase, waitForDns: async () => {}, pollMs: 10 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse' })).cookie.split(';')[0];
  // Admins need two-step sign-in before Admin opens.
  const { secret } = (await call('POST', '/api/me/two-step/start')).body;
  await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(secret, twoStep.currentStep()) });
});

after(() => {
  server.close();
  acme.close();
  cf.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 200; i++) {
    const s = (await call('GET', '/api/admin/tls')).body;
    if (s.state !== 'working') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('certificate request never finished');
}

test('the certificate request is valid and lists every name', { skip: !hasOpenssl && 'needs openssl' }, () => {
  const der = createCsr(newKey(), ['roostos.network', '*.roostos.network']);
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  const out = execFileSync('openssl', ['req', '-noout', '-verify', '-text'], { input: pem, stderr: 'pipe' }).toString();
  assert.match(out, /DNS:roostos\.network, DNS:\*\.roostos\.network/);
});

test('HTTPS starts off and only admins can see or change it', async () => {
  const s = await call('GET', '/api/admin/tls');
  assert.equal(s.body.state, 'off');
  assert.equal(s.body.tokenSaved, false);
  const res = await fetch(base + '/api/admin/tls');
  assert.equal(res.status, 401);
});

test('bad domains and missing tokens are refused', async () => {
  assert.equal((await call('PUT', '/api/admin/tls', { domain: 'not a domain', token: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/tls', { domain: 'roostos.network' })).status, 400);
  assert.equal((await call('POST', '/api/admin/tls/renew')).status, 400);
});

test('a refused Cloudflare token shows a clear error', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  const put = await call('PUT', '/api/admin/tls', { domain: 'https://roostos.network/', token: 'cf-wrong' });
  assert.equal(put.status, 200);
  assert.equal(put.body.domain, 'roostos.network');
  const s = await settle();
  assert.equal(s.state, 'error');
  assert.match(s.lastError, /Cloudflare refused the token/);
});

test('gets a certificate for the domain and its subdomains', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  const put = await call('PUT', '/api/admin/tls', { domain: 'roostos.network', token: 'cf-good', email: 'raven@example.com' });
  assert.equal(put.body.tokenSaved, true);
  assert.equal(JSON.stringify(put.body).includes('cf-good'), false, 'token is never sent back');
  const s = await settle();
  assert.equal(s.state, 'active', s.lastError);
  assert.deepEqual(s.certificate.names, ['roostos.network', '*.roostos.network']);
  assert.equal(s.certificate.issuer, 'Fake Encrypt');
  assert.ok(s.certificate.daysLeft >= 89);
  assert.equal(dns.size, 0, 'challenge records are cleaned up');
  const files = fs.readdirSync(path.join(tmp, 'data', 'tls')).sort();
  assert.deepEqual(files, ['account.pem', 'cert.pem', 'key.pem']);
});

test('serves HTTPS with the new certificate', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  const httpsServer = server.createHttpsServer();
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  try {
    const { port } = httpsServer.address();
    const body = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'roost.roostos.network', ca: fs.readFileSync(caCert) }, () => {
        socket.write('GET /api/state HTTP/1.1\r\nHost: roost.roostos.network\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (d) => { data += d; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(body, /^HTTP\/1\.1 200/);
    assert.match(body, /"serverName":"Roost"/);
  } finally {
    httpsServer.close();
  }
});

test('sign-in cookies are marked Secure over HTTPS', async () => {
  // Signing out sends the same cookie (emptied), with no two-step in the way.
  const viaProxy = await fetch(base + '/api/logout', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(viaProxy.headers.get('set-cookie'), /; Secure/);
  const plain = await fetch(base + '/api/logout', { method: 'POST' });
  assert.doesNotMatch(plain.headers.get('set-cookie'), /; Secure/);
});

test('the status page tells admins about the certificate', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  const s = (await call('GET', '/api/status')).body;
  assert.equal(s.certificate.state, 'active');
  assert.equal(s.certificate.domain, 'roostos.network');
});

test('a failed renewal keeps the working certificate and warns', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  failChallenges = true;
  try {
    await call('POST', '/api/admin/tls/renew');
    const s = await settle();
    assert.ok(s.certificate, 'old certificate still in use');
    assert.match(s.lastError, /No TXT record found/);
    assert.equal(s.state, 'active', 'still fine: more than 30 days left');
  } finally {
    failChallenges = false;
  }
});

test('turning HTTPS off forgets the token and certificate', { skip: !hasOpenssl && 'needs openssl' }, async () => {
  const s = (await call('DELETE', '/api/admin/tls')).body;
  assert.equal(s.state, 'off');
  assert.equal(s.certificate, null);
  assert.equal(s.tokenSaved, false);
  assert.equal(fs.existsSync(path.join(tmp, 'data', 'tls', 'cert.pem')), false);
});
