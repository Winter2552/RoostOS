'use strict';

// Keeps one kind of secret (an API key) encrypted in roost.json instead of in
// plain text. AES-256-GCM, with the key in its own file (secret.key, mode 0600)
// next to roost.json but not inside it.
//
// What this protects against: a copy of roost.json alone (a leaked backup, the
// file pasted into a bug report, a Nest share of the data folder) does not
// reveal the secret. What it does not protect against: someone who can read
// the whole data folder or run code on the box has both halves. That is the
// limit of any secret a running server must be able to use on its own.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function keyFor(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 32) return raw;
  } catch { /* not made yet */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return key;
}

// -> { iv, tag, data } (all base64), safe to keep in roost.json
function seal(dataDir, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(dataDir), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// The text, or null if the box is missing, damaged or the key file is gone.
function open(dataDir, box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(dataDir), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { seal, open };
