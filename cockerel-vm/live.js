'use strict';

// Cockerel's live log: one short line per thing he does, for the VM desktop
// window (cockerel-watch). Plain text, trimmed so it never grows large. It
// holds only what he is doing, never the secret or whole emails.

const fs = require('fs');
const path = require('path');

const FILE = process.env.COCKEREL_LIVE_LOG || '/var/log/cockerel/live.log';
const MAX_BYTES = 200 * 1024;

const clip = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function live(text) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const t = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(FILE, `${t}  ${clip(text, 200)}\n`);
    if (fs.statSync(FILE).size > MAX_BYTES) {
      const lines = fs.readFileSync(FILE, 'utf8').split('\n');
      fs.writeFileSync(FILE, lines.slice(-Math.floor(lines.length / 2)).join('\n'));
    }
  } catch { /* the log is a nicety; never break a job over it */ }
}

// One line of Claude's stream-json output -> what to show (or '').
function describe(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return ''; }
  if (ev.type === 'assistant') {
    return (ev.message?.content || []).map((c) => {
      if (c.type === 'tool_use') {
        const cmd = c.input?.command || c.input?.query || c.input?.url || c.input?.prompt || '';
        return `> ${c.name}${cmd ? `: ${clip(cmd, 110)}` : ''}`;
      }
      if (c.type === 'text' && c.text.trim()) return `says: ${clip(c.text, 140)}`;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

module.exports = { live, describe, clip };

// ---------- the live page (served on this VM's own address only) ----------
// Sends the last lines, then each new line as it is written (fs.watch, no
// polling), plus a small status update every 5 s while someone is watching.
function recent(n = 80) {
  try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}

function stream(req, res, status) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  recent().forEach((l) => send('line', l));
  send('status', status());
  let size = 0;
  try { size = fs.statSync(FILE).size; } catch { /* no log yet */ }
  let watcher = null;
  const onChange = () => {
    try {
      const now = fs.statSync(FILE).size;
      if (now < size) size = 0; // trimmed
      const fd = fs.openSync(FILE, 'r');
      const buf = Buffer.alloc(now - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = now;
      buf.toString('utf8').split('\n').filter(Boolean).forEach((l) => send('line', l));
    } catch { /* ignore */ }
  };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.closeSync(fs.openSync(FILE, 'a')); watcher = fs.watch(FILE, onChange); } catch { /* the 5 s tick still works */ }
  const tick = setInterval(() => { send('status', status()); onChange(); }, 5000);
  req.on('close', () => { clearInterval(tick); if (watcher) watcher.close(); });
}

const isLocal = (req) => /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '');

module.exports.stream = stream;
module.exports.isLocal = isLocal;
