'use strict';

// A small SMTP client, enough to hand a plain-text email to a relay
// (Resend, Brevo, Gmail, a mail server you run elsewhere). Supports implicit
// TLS (port 465), STARTTLS (587) and, for a relay on your own network, none.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const SECURITY = ['tls', 'starttls', 'none'];
const TIMEOUT_MS = 15 * 1000;

// Reads SMTP replies (possibly multi-line: "250-..." then "250 ...").
class Reader {
  constructor(socket) {
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiting = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        this.lines.push(this.buffer.slice(0, i).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.flush();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('The mail server closed the connection')));
  }

  fail(err) {
    this.error = this.error || err;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(this.error);
    }
  }

  flush() {
    if (!this.waiting) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const lines = this.lines.splice(0, end + 1);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve({ code: Number(lines[end].slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') });
  }

  reply() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.flush();
    });
  }
}

// TLS names the server it expects, except when it is given as an IP address.
function serverName(host) {
  return net.isIP(host) ? undefined : host;
}

function connect(options, useTls) {
  return new Promise((resolve, reject) => {
    const socket = useTls
      ? tls.connect({ host: options.host, port: options.port, servername: serverName(options.host), ...options.tlsOptions })
      : net.connect({ host: options.host, port: options.port });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('The mail server took too long to answer')));
    socket.once(useTls ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function upgrade(socket, options) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    const secure = tls.connect({ socket, servername: serverName(options.host), ...options.tlsOptions });
    secure.setTimeout(TIMEOUT_MS, () => secure.destroy(new Error('The mail server took too long to answer')));
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

// Header text outside plain ASCII is sent as an encoded word.
function headerText(s) {
  const clean = String(s).replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString('base64')}?=`;
}

function addressOnly(a) {
  const m = String(a).match(/<([^>]+)>/);
  return (m ? m[1] : String(a)).trim();
}

function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(e);
}

function buildMessage({ from, fromName, to, subject, text }) {
  const domain = from.split('@')[1] || 'roost';
  const headers = [
    `From: ${fromName ? `${headerText(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

// Sends one email. `config` is the saved mail settings plus the password.
async function send(config, message) {
  const options = { host: config.host, port: config.port, tlsOptions: config.tlsOptions || {} };
  let socket = await connect(options, config.security === 'tls');
  const reader = new Reader(socket);
  const write = (line) => socket.write(`${line}\r\n`);
  const expect = async (codes, what) => {
    const r = await reader.reply();
    if (!codes.includes(r.code)) throw new Error(`Mail server refused ${what}: ${r.code} ${r.text.split('\n')[0]}`);
    return r;
  };
  try {
    await expect([220], 'the connection');
    const hello = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'roost';
    write(`EHLO ${hello}`);
    let ehlo = await expect([250], 'EHLO');
    if (config.security === 'starttls') {
      if (!/^STARTTLS\b/im.test(ehlo.text)) throw new Error("The mail server doesn't offer STARTTLS");
      write('STARTTLS');
      await expect([220], 'STARTTLS');
      socket = await upgrade(socket, options);
      reader.attach(socket);
      write(`EHLO ${hello}`);
      ehlo = await expect([250], 'EHLO');
    }
    if (config.user) {
      const plain = Buffer.from(`\0${config.user}\0${config.password || ''}`).toString('base64');
      write(`AUTH PLAIN ${plain}`);
      await expect([235], 'the username or password');
    }
    write(`MAIL FROM:<${addressOnly(message.from)}>`);
    await expect([250], 'the sender address');
    write(`RCPT TO:<${addressOnly(message.to)}>`);
    await expect([250, 251], 'the recipient');
    write('DATA');
    await expect([354], 'the message');
    // A line starting with "." would end the message early, so double it.
    socket.write(`${buildMessage(message).replace(/^\./gm, '..')}.\r\n`);
    await expect([250], 'the message');
    write('QUIT');
  } finally {
    socket.end();
  }
}

module.exports = { SECURITY, send, validEmail, buildMessage };
