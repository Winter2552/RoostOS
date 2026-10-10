'use strict';

// Phone alerts: Roost's own Web Push sender, on Node's built-in crypto, so it
// needs no packages and no account anywhere. A phone or PC that has turned on
// alerts hands Roost an address at its browser's push service (Apple, Google,
// Mozilla or Microsoft); Roost sends an encrypted message there and the push
// service wakes the device. The message is encrypted for that one device
// (RFC 8291), so the push service only ever sees a sealed blob.
//
// Nothing runs on a timer: a message is sent only when an alert opens or
// clears. Messages are signed with this Roost's own key (VAPID, RFC 8292),
// made on first use and kept in the data file.

const crypto = require('crypto');
const https = require('https');

const RECORD_SIZE = 4096;
const MAX_DEVICES = 20;
const SEND_TIMEOUT_MS = 10 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// The browsers' own push services. A device can only hand Roost an address on
// one of these, so a signed-in admin can't point Roost at something else.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates(-autopush)?\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)?push\.apple\.com$/,
  /^([a-z0-9-]+\.)?notify\.windows\.com$/,
];

function validEndpoint(endpoint, hosts = PUSH_HOSTS) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && !u.username && hosts.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// RFC 8291: encrypt `payload` for a device's public key and auth secret.
// `ephemeral` and `salt` are only given by tests that check the RFC's example.
function encrypt(payload, p256dh, auth, { ephemeral, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Bad device keys');
  const as = ephemeral || crypto.createECDH('prime256v1');
  if (!ephemeral) as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // The final record ends with a 0x02 marker (RFC 8188).
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

function newVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateKey: b64u(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

// RFC 8292: a signed note saying which Roost is sending, good for 12 hours.
function vapidHeader(vapid, endpoint, subject, now = Date.now()) {
  const part = (o) => b64u(JSON.stringify(o));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const key = crypto.createPrivateKey({ key: fromB64u(vapid.privateKey), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${vapid.publicKey}`;
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: SEND_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('Push service timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// "iPhone", "Android phone", "Windows PC" and so on, from the browser's own description.
function deviceLabel(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Device';
  return /iPhone|iPad|Android/.test(os) ? os : `${os}${browser ? ` · ${browser}` : ''}`;
}

class Push {
  // post(url, headers, body) → { status }; swapped out in tests.
  // isAdmin(userId) says whether alerts should still go to that person.
  constructor({ store, isAdmin, post = httpsPost, hosts = PUSH_HOSTS, subject, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.store = store;
    this.isAdmin = isAdmin;
    this.post = post;
    this.hosts = hosts;
    this.subject = subject;
    this.now = now;
    this.wait = wait;
    this.pending = new Set();
  }

  get data() {
    const db = this.store.db;
    if (!db.push) db.push = { vapid: null, devices: [] };
    return db.push;
  }

  // The public half, which a browser needs to subscribe. Made on first ask.
  publicKey() {
    if (!this.data.vapid) {
      this.data.vapid = newVapid();
      this.store.save();
    }
    return this.data.vapid.publicKey;
  }

  devicesOf(userId) {
    return this.data.devices.filter((d) => d.userId === userId);
  }

  // Adds a device, or refreshes one Roost already knows (same address).
  subscribe(userId, sub, { userAgent = '', host = '' } = {}) {
    const keys = (sub && sub.keys) || {};
    if (!sub || !validEndpoint(sub.endpoint, this.hosts)) throw Object.assign(new Error("That browser's push address isn't one Roost can send to"), { status: 400 });
    try {
      encrypt('x', keys.p256dh, keys.auth);
    } catch {
      throw Object.assign(new Error('The device keys look wrong'), { status: 400 });
    }
    this.publicKey(); // a device can't have subscribed without Roost's key, but make sure it exists
    const list = this.data.devices;
    let device = list.find((d) => d.endpoint === sub.endpoint);
    if (!device) {
      if (this.devicesOf(userId).length >= MAX_DEVICES) throw Object.assign(new Error('Remove a device first'), { status: 400 });
      device = { id: crypto.randomBytes(8).toString('hex'), createdAt: new Date(this.now()).toISOString() };
      list.push(device);
    }
    const fresh = { userId, endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth, label: deviceLabel(userAgent), host };
    // The Admin page re-sends what the browser holds each time it opens, so
    // only touch the disk when something is actually new.
    if (Object.keys(fresh).some((k) => device[k] !== fresh[k])) {
      Object.assign(device, fresh);
      this.store.save();
    }
    return device;
  }

  remove(id, userId) {
    const list = this.data.devices;
    const i = list.findIndex((d) => d.id === id && d.userId === userId);
    if (i < 0) return false;
    list.splice(i, 1);
    this.store.save();
    return true;
  }

  // Sends one message to one device. → 'sent' | 'gone' | 'failed'
  async sendTo(device, message, { ttl = 3600, urgency = 'high' } = {}) {
    const vapid = this.data.vapid;
    if (!vapid) return 'failed';
    const subject = (typeof this.subject === 'function' ? this.subject() : this.subject) || `https://${device.host}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = encrypt(JSON.stringify(message), device.p256dh, device.auth);
        const { status } = await this.post(device.endpoint, {
          Authorization: vapidHeader(vapid, device.endpoint, subject, this.now()),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttl),
          Urgency: urgency,
        }, body);
        if (status >= 200 && status < 300) return 'sent';
        // The device turned alerts off or uninstalled Roost: forget it.
        if (status === 404 || status === 410) return 'gone';
        if (status < 500) return 'failed';
      } catch {
        // Network trouble: try once more below.
      }
      if (attempt === 0) await this.wait(5000);
    }
    return 'failed';
  }

  // Sends to these devices and drops the ones that are gone.
  async sendAll(devices, message, opts) {
    const result = { sent: 0, failed: 0, removed: 0 };
    await Promise.all(devices.map(async (d) => {
      const r = await this.sendTo(d, message, opts);
      if (r === 'sent') result.sent++;
      else if (r === 'gone') {
        result.removed++;
        this.data.devices = this.data.devices.filter((x) => x.id !== d.id);
      } else result.failed++;
    }));
    if (result.removed) this.store.save();
    return result;
  }

  // An alert opened or cleared: tell every admin device. A cleared alert uses
  // the same tag, so "Jellyfin is back" replaces "Jellyfin has stopped".
  alert(kind, alert) {
    if (kind === 'event') return;
    if (kind === 'resolved' && alert.dismissedAt) return;
    const devices = this.data.devices.filter((d) => this.isAdmin(d.userId));
    if (!devices.length) return;
    const raised = kind === 'raised';
    const message = {
      title: raised ? alert.title : alert.okTitle || `${alert.title} (cleared)`,
      body: raised ? alert.detail : 'The problem has cleared.',
      tag: alert.key,
      url: '/#/status',
    };
    const job = this.sendAll(devices, message, { ttl: raised ? 3600 : 1800, urgency: raised ? 'high' : 'normal' })
      .catch((err) => console.error('Phone alert failed:', err.message))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  // For tests and a clean shutdown: wait for sends in flight.
  idle() {
    return Promise.all([...this.pending]);
  }
}

module.exports = { Push, encrypt, validEndpoint, vapidHeader, newVapid, deviceLabel, PUSH_HOSTS };
