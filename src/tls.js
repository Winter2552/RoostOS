'use strict';

// Keeps Roost's HTTPS certificate: loads it at start, gets a new one from
// Let's Encrypt when there is none or it has under 30 days left, and swaps it
// into the running HTTPS server without a restart. Checks twice a day.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { Resolver } = require('dns').promises;
const { AcmeClient, LETS_ENCRYPT, LETS_ENCRYPT_STAGING, newKey } = require('./acme');
const { CloudflareDns } = require('./cloudflare');

const DAY = 24 * 60 * 60 * 1000;
const RENEW_DAYS = 30;
const CHECK_EVERY_MS = DAY / 2;

function validDomain(d) {
  return typeof d === 'string' && d.length <= 200 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d);
}

// Waits until public DNS shows the challenge record, so Let's Encrypt
// doesn't look too early. Gives up quietly after two minutes and lets
// Let's Encrypt try anyway.
async function waitForPublicDns(name, value, { tries = 24, waitMs = 5000 } = {}) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  for (let i = 0; i < tries; i++) {
    try {
      const records = await resolver.resolveTxt(name);
      if (records.some((r) => r.join('') === value)) return;
    } catch {
      // Not there yet.
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class CertManager {
  constructor({ dataDir, getConfig, staging = false, directoryUrl, cloudflareApi, fetchImpl, waitForDns = waitForPublicDns, pollMs, now = Date.now }) {
    this.dir = path.join(dataDir, 'tls');
    this.getConfig = getConfig;
    this.staging = staging;
    this.directoryUrl = directoryUrl || (staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT);
    this.cloudflareApi = cloudflareApi;
    this.fetchImpl = fetchImpl;
    this.waitForDns = waitForDns;
    this.pollMs = pollMs;
    this.now = now;
    this.context = null;
    this.cert = null;
    this.busy = null;
    this.step = '';
    this.lastError = null;
    this.lastAttemptAt = null;
    this.timer = null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  load() {
    try {
      const key = fs.readFileSync(this.file('key.pem'));
      const chain = fs.readFileSync(this.file('cert.pem'));
      const x509 = new crypto.X509Certificate(chain);
      const org = x509.issuer.split('\n').find((l) => l.startsWith('O='));
      this.context = tls.createSecureContext({ key, cert: chain });
      this.cert = {
        names: (x509.subjectAltName || '').split(', ').map((n) => n.replace(/^DNS:/, '')).filter(Boolean),
        expiresAt: new Date(x509.validTo).toISOString(),
        issuedAt: new Date(x509.validFrom).toISOString(),
        issuer: org ? org.slice(2) : x509.issuer,
      };
    } catch {
      this.context = null;
      this.cert = null;
    }
    return this.cert;
  }

  daysLeft() {
    return this.cert ? Math.floor((Date.parse(this.cert.expiresAt) - this.now()) / DAY) : null;
  }

  coversDomain(domain) {
    return !!this.cert && this.cert.names.includes(domain) && this.cert.names.includes(`*.${domain}`);
  }

  needsRenewal() {
    const { domain, token } = this.getConfig() || {};
    if (!domain || !token) return false;
    return !this.coversDomain(domain) || this.daysLeft() < RENEW_DAYS;
  }

  status() {
    const { domain = '', token, email = '' } = this.getConfig() || {};
    const days = this.daysLeft();
    let state = 'off';
    if (this.busy) state = 'working';
    else if (this.cert && days >= 0 && (!domain || this.coversDomain(domain))) state = this.lastError && days < RENEW_DAYS ? 'warning' : 'active';
    else if (this.lastError) state = 'error';
    else if (domain && token) state = 'pending';
    return {
      state,
      domain,
      email,
      tokenSaved: !!token,
      staging: this.staging,
      step: this.busy ? this.step : '',
      certificate: this.cert ? { ...this.cert, daysLeft: days } : null,
      lastError: this.lastError,
      lastAttemptAt: this.lastAttemptAt,
    };
  }

  // Starts getting a certificate; returns the running attempt if one is going.
  renew() {
    if (!this.busy) {
      this.busy = this.obtain().finally(() => {
        this.busy = null;
        this.step = '';
      });
    }
    return this.busy;
  }

  async obtain() {
    const { domain, token, email } = this.getConfig() || {};
    this.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      if (!validDomain(domain)) throw new Error('Set the domain first');
      if (!token) throw new Error('Add a Cloudflare API token first');
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

      const accountFile = this.file(this.staging ? 'account-staging.pem' : 'account.pem');
      let accountKey;
      if (fs.existsSync(accountFile)) accountKey = crypto.createPrivateKey(fs.readFileSync(accountFile));
      else {
        accountKey = newKey();
        writeAtomic(accountFile, accountKey.export({ type: 'pkcs8', format: 'pem' }));
      }

      const certKey = newKey();
      const client = new AcmeClient({ directoryUrl: this.directoryUrl, accountKey, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      const dns = new CloudflareDns({ token, domain, ...(this.cloudflareApi ? { apiBase: this.cloudflareApi } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      const chain = await client.obtain({
        names: [domain, `*.${domain}`],
        certKey,
        dns,
        email,
        waitForDns: this.waitForDns,
        pollMs: this.pollMs,
        onStep: (s) => { this.step = s; },
      });

      // Check the pair works before replacing the one in use.
      tls.createSecureContext({ key: certKey.export({ type: 'pkcs8', format: 'pem' }), cert: chain });
      writeAtomic(this.file('key.pem'), certKey.export({ type: 'pkcs8', format: 'pem' }));
      writeAtomic(this.file('cert.pem'), chain);
      this.load();
      this.lastError = null;
      console.log(`HTTPS certificate for ${domain} ready, valid until ${this.cert.expiresAt}`);
    } catch (err) {
      this.lastError = err.message || String(err);
      console.error(`HTTPS certificate: ${this.lastError}`);
    }
    return this.status();
  }

  async check() {
    if (this.needsRenewal()) await this.renew();
  }

  start() {
    this.load();
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Forget the domain's certificate, for when the admin turns HTTPS off.
  clear() {
    for (const f of ['key.pem', 'cert.pem']) fs.rmSync(this.file(f), { force: true });
    this.context = null;
    this.cert = null;
    this.lastError = null;
  }
}

module.exports = { CertManager, validDomain, waitForPublicDns, RENEW_DAYS };
