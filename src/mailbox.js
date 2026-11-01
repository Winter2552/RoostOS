'use strict';

// Read-only email for Cockerel: a small IMAP client written for one job,
// listing recent messages (who, subject, when, a short snippet). It opens the
// inbox with EXAMINE and fetches with BODY.PEEK, so nothing is marked as read,
// moved or deleted, and it never sends. The app password is kept encrypted by
// Roost; the VM never sees it.

const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 20000;

const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

// "=?utf-8?B?...?=" and "=?utf-8?Q?...?=" in headers.
function decodeWords(text) {
  return String(text || '').replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, data) => {
    try {
      const buf = enc.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(cs.toLowerCase() === 'utf-8' ? 'utf-8' : 'latin1').decode(buf);
    } catch { return data; }
  }).replace(/\s+/g, ' ').trim();
}

function header(block, name) {
  const m = new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r?\\n[ \\t].*)*)`, 'im').exec(block);
  return m ? decodeWords(m[1].replace(/\r?\n[ \t]+/g, ' ')) : '';
}

function snippet(raw) {
  let t = String(raw || '');
  // A multipart message: take the first readable text part's body.
  if (/^--\S+/m.test(t)) {
    const parts = t.split(/^--\S+.*$/m).map((p) => p.trim()).filter(Boolean);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) || parts.find((p) => /content-type:\s*text\/html/i.test(p)) || parts[0] || '';
    t = plain.replace(/^[\s\S]*?\r?\n\r?\n/, '');
  }
  t = t.replace(/=\r?\n/g, '').replace(/(?:=[0-9A-F]{2})+/g, (run) => Buffer.from(run.replace(/=/g, ''), 'hex').toString('utf8'));
  t = t.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return t.replace(/[\r\n\t ]+/g, ' ').trim().slice(0, 200);
}

class Imap {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiting = null;
    this.tag = 0;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    socket.on('error', (err) => this.wake(err));
    socket.on('close', () => this.wake(new Error('The mail server closed the connection')));
  }

  wake(err) {
    if (err) this.err = err;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }
  }

  async until(test) {
    for (;;) {
      const got = test(this.buf);
      if (got) return got;
      if (this.err) throw this.err;
      await new Promise((resolve, reject) => {
        this.waiting = resolve;
        setTimeout(() => reject(new Error('The mail server took too long')), TIMEOUT_MS).unref();
      });
    }
  }

  async greeting() {
    await this.until((b) => b.includes('\r\n'));
    this.buf = this.buf.subarray(this.buf.indexOf('\r\n') + 2);
  }

  // Sends one command; returns the untagged text up to the tagged reply.
  async run(command) {
    const tag = `a${++this.tag}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const done = await this.until((b) => {
      const s = b.toString('latin1');
      const m = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r]*)\\r\\n`).exec(s);
      return m ? { end: m.index + m[0].length, status: m[2], note: m[3].trim() } : null;
    });
    const text = this.buf.subarray(0, done.end).toString('utf8');
    this.buf = this.buf.subarray(done.end);
    if (done.status !== 'OK') throw new Error(done.status === 'NO' && /^LOGIN|^AUTH/i.test(command) ? 'The mail server refused the sign-in. Check the address and app password.' : `The mail server said: ${done.note.slice(0, 80)}`);
    return text;
  }
}

// The newest `count` messages (unread only if asked). Each: from, subject, date, snippet.
async function recent({ host, port = 993, user, pass, secure = true, count = 8, unreadOnly = true, timeout = TIMEOUT_MS }) {
  const socket = (secure ? tls : net).connect({ host, port, servername: host, timeout });
  socket.setTimeout(timeout, () => socket.destroy(new Error('The mail server took too long')));
  const imap = new Imap(socket);
  try {
    await imap.greeting();
    await imap.run(`LOGIN ${quote(user)} ${quote(pass)}`);
    await imap.run('EXAMINE INBOX'); // read-only
    const found = await imap.run(unreadOnly ? 'SEARCH UNSEEN' : 'SEARCH ALL');
    const ids = ((/^\* SEARCH ([\d ]+)/m.exec(found) || [])[1] || '').trim().split(/\s+/).filter(Boolean).slice(-Math.min(Math.max(count, 1), 15));
    if (!ids.length) return [];
    const raw = await imap.run(`FETCH ${ids.join(',')} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.1200>)`);
    // Each message is two literals: {n}\r\n<bytes>. Walk them by length.
    const out = [];
    const bytes = Buffer.from(raw, 'utf8');
    let cur = null;
    for (let at = 0; at < bytes.length;) {
      const rest = bytes.subarray(at).toString('utf8');
      const m = /\{(\d+)\}\r\n/.exec(rest);
      if (!m) break;
      const start = at + Buffer.byteLength(rest.slice(0, m.index + m[0].length));
      const body = bytes.subarray(start, start + Number(m[1])).toString('utf8');
      const before = rest.slice(0, m.index);
      if (/HEADER\.FIELDS/i.test(before)) {
        cur = { from: header(body, 'From'), subject: header(body, 'Subject'), date: header(body, 'Date'), snippet: '' };
        out.push(cur);
      } else if (cur) cur.snippet = snippet(body);
      at = start + Number(m[1]);
    }
    await imap.run('LOGOUT').catch(() => {});
    return out.reverse();
  } finally {
    socket.destroy();
  }
}

module.exports = { recent, decodeWords, snippet };
