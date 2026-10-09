'use strict';

// Roost's end of the private link to the server that runs Coffee Galaxy.
// Roost makes its own key pair (the private key never leaves /data), writes
// the WireGuard config from the other side's public key and address, and
// brings the link up with wg-quick when the container has it. Nothing here
// opens a port at home: Roost connects out to the other server.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ADDRESS = '10.77.0.1';
const PEER_ADDRESS = '10.77.0.2';
const PORT = 51820;
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const ENDPOINT_RE = /^([A-Za-z0-9.-]{1,200})(?::(\d{1,5}))?$/;

// WireGuard keys are raw 32-byte X25519 keys in base64. Node hands them back
// wrapped in DER, where the raw key is the last 32 bytes.
function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
}

// The public half of a private key (so the key file is the only thing kept).
function publicOf(privateB64) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateB64, 'base64')]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

function validKey(k) {
  return typeof k === 'string' && KEY_RE.test(k);
}

// "141.147.108.43" or "example.com:51820" → "host:port"; null when it isn't one.
function cleanEndpoint(v) {
  const m = ENDPOINT_RE.exec(String(v || '').trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : PORT;
  return port >= 1 && port <= 65535 ? `${m[1]}:${port}` : null;
}

function configText({ privateKey, peerPublicKey, endpoint }) {
  return `[Interface]
Address = ${ADDRESS}/24
PrivateKey = ${privateKey}

[Peer]
PublicKey = ${peerPublicKey}
Endpoint = ${endpoint}
AllowedIPs = ${PEER_ADDRESS}/32
PersistentKeepalive = 25
`;
}

class WireGuard {
  constructor(dir, { run = execFile } = {}) {
    this.dir = dir;
    this.keyFile = path.join(dir, 'privatekey');
    this.confFile = path.join(dir, 'wg0.conf');
    this.run = run;
  }

  // Makes the key pair on first use and returns the public key to give the other side.
  publicKey() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyFile)) {
      fs.writeFileSync(this.keyFile, makeKeys().privateKey + '\n', { mode: 0o600 });
    }
    return publicOf(fs.readFileSync(this.keyFile, 'utf8').trim());
  }

  write({ peerPublicKey, endpoint }) {
    this.publicKey();
    const privateKey = fs.readFileSync(this.keyFile, 'utf8').trim();
    fs.writeFileSync(this.confFile, configText({ privateKey, peerPublicKey, endpoint }), { mode: 0o600 });
  }

  remove() {
    fs.rmSync(this.confFile, { force: true });
  }

  // Brings the link up (or down with no config). Resolves with a short note,
  // never throws: a container without wg-quick still saves its settings.
  apply() {
    const call = (args) => new Promise((resolve) => this.run('wg-quick', args, { timeout: 15000 }, (err, _out, stderr) => resolve({ err, stderr: String(stderr || '') })));
    return (async () => {
      await call(['down', this.confFile]);
      if (!fs.existsSync(this.confFile)) return { ok: true, note: 'Link is off' };
      const { err, stderr } = await call(['up', this.confFile]);
      if (!err) return { ok: true, note: '' };
      if (err.code === 'ENOENT') return { ok: false, note: 'This Roost has no WireGuard tools. Rebuild it from the latest compose file, then save again' };
      return { ok: false, note: /Operation not permitted|Permission denied|RTNETLINK/.test(stderr) ? 'The container may not manage network links. Add cap_add: NET_ADMIN to Roost in the compose file' : `WireGuard said: ${stderr.trim().split('\n').pop() || err.message}` };
    })();
  }
}

module.exports = { WireGuard, makeKeys, publicOf, validKey, cleanEndpoint, configText, ADDRESS, PEER_ADDRESS, PORT };
