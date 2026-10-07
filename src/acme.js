'use strict';

// Minimal ACME (RFC 8555) client for Let's Encrypt, using only Node's crypto.
// It proves control of a domain with DNS-01 challenges, so the server needs
// no open ports to get a certificate. Keys are ECDSA P-256 throughout.

const crypto = require('crypto');

const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function newKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

function publicJwk(key) {
  const pub = key.type === 'public' ? key : crypto.createPublicKey(key);
  const { crv, kty, x, y } = pub.export({ format: 'jwk' });
  return { crv, kty, x, y };
}

// RFC 7638: members in lexicographic order, no whitespace.
function thumbprint(key) {
  const { crv, kty, x, y } = publicJwk(key);
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
}

function dnsTxtValue(token, key) {
  return b64u(crypto.createHash('sha256').update(`${token}.${thumbprint(key)}`).digest());
}

// ---------- DER, just enough for a certificate signing request ----------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derOid(oid) {
  const [a, b, ...rest] = oid.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

const seq = (...p) => der(0x30, ...p);

function createCsr(key, names) {
  const subject = seq(der(0x31, seq(derOid('2.5.4.3'), der(0x0c, Buffer.from(names[0])))));
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const san = seq(...names.map((n) => der(0x82, Buffer.from(n))));
  const extensions = seq(seq(derOid('2.5.29.17'), der(0x04, san)));
  const attributes = der(0xa0, seq(derOid('1.2.840.113549.1.9.14'), der(0x31, extensions)));
  const info = seq(der(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = crypto.sign('sha256', info, key);
  return seq(info, seq(derOid('1.2.840.10045.4.3.2')), der(0x03, Buffer.from([0]), signature));
}

// ---------- client ----------

class AcmeError extends Error {
  constructor(message, problem) {
    super(message);
    this.problem = problem;
  }
}

class AcmeClient {
  constructor({ directoryUrl = LETS_ENCRYPT, accountKey, fetchImpl = fetch }) {
    this.directoryUrl = directoryUrl;
    this.key = accountKey;
    this.fetch = fetchImpl;
    this.nonce = null;
    this.kid = null;
  }

  async directory() {
    if (!this.dir) {
      const res = await this.fetch(this.directoryUrl);
      if (!res.ok) throw new AcmeError(`Let's Encrypt is not answering (${res.status})`);
      this.dir = await res.json();
    }
    return this.dir;
  }

  async freshNonce() {
    const res = await this.fetch((await this.directory()).newNonce, { method: 'HEAD' });
    return res.headers.get('replay-nonce');
  }

  // Signed POST. payload undefined = POST-as-GET.
  async post(url, payload, { retry = true } = {}) {
    const nonce = this.nonce || (await this.freshNonce());
    this.nonce = null;
    const header = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: publicJwk(this.key) }) };
    const protectedB64 = b64u(JSON.stringify(header));
    const payloadB64 = payload === undefined ? '' : b64u(JSON.stringify(payload));
    const signature = crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json' },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) }),
    });
    this.nonce = res.headers.get('replay-nonce');
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      if (retry && problem.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, { retry: false });
      throw new AcmeError(problem.detail || `Let's Encrypt said no (${res.status})`, problem);
    }
    return res;
  }

  async register(email) {
    const res = await this.post((await this.directory()).newAccount, {
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    });
    this.kid = res.headers.get('location');
    return this.kid;
  }

  async poll(url, done, { tries = 30, waitMs = 2000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const obj = await (await this.post(url)).json();
      if (done(obj)) return obj;
      if (obj.status === 'invalid') {
        const err = obj.error || (obj.challenges || []).map((c) => c.error).find(Boolean);
        throw new AcmeError(err && err.detail ? err.detail : "Let's Encrypt could not confirm the domain", err);
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new AcmeError("Let's Encrypt took too long to answer");
  }

  // Runs one order end to end. dns.set(name, value) / dns.remove(handle) put the
  // challenge TXT records in place; onStep reports progress for the admin page.
  async obtain({ names, certKey, dns, email, waitForDns = async () => {}, onStep = () => {}, pollMs }) {
    onStep('Signing in to Let\'s Encrypt');
    if (!this.kid) await this.register(email);

    onStep('Asking for a certificate');
    const orderRes = await this.post((await this.directory()).newOrder, {
      identifiers: names.map((value) => ({ type: 'dns', value })),
    });
    const orderUrl = orderRes.headers.get('location');
    let order = await orderRes.json();

    const pending = [];
    for (const authUrl of order.authorizations) {
      const auth = await (await this.post(authUrl)).json();
      if (auth.status === 'valid') continue;
      const challenge = auth.challenges.find((c) => c.type === 'dns-01');
      if (!challenge) throw new AcmeError('Let\'s Encrypt offered no DNS check for this domain');
      pending.push({ authUrl, challenge, name: `_acme-challenge.${auth.identifier.value}`, value: dnsTxtValue(challenge.token, this.key) });
    }

    const handles = [];
    try {
      onStep('Adding the check record to your DNS');
      for (const p of pending) handles.push(await dns.set(p.name, p.value));
      onStep('Waiting for the DNS record to show up');
      for (const p of pending) await waitForDns(p.name, p.value);

      onStep('Let\'s Encrypt is checking the domain');
      for (const p of pending) await this.post(p.challenge.url, {});
      for (const p of pending) await this.poll(p.authUrl, (a) => a.status === 'valid', { waitMs: pollMs });
    } finally {
      for (const h of handles) await dns.remove(h).catch(() => {});
    }

    onStep('Collecting the certificate');
    order = await this.poll(orderUrl, (o) => o.status === 'ready' || o.status === 'valid', { waitMs: pollMs });
    if (order.status === 'ready') {
      await this.post(order.finalize, { csr: b64u(createCsr(certKey, names)) });
      order = await this.poll(orderUrl, (o) => o.status === 'valid', { waitMs: pollMs });
    }
    return (await this.post(order.certificate)).text();
  }
}

module.exports = { AcmeClient, AcmeError, LETS_ENCRYPT, LETS_ENCRYPT_STAGING, newKey, createCsr, thumbprint, dnsTxtValue, publicJwk };
