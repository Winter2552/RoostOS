'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { buildMessage } = require('../src/mail');

// A pretend mail relay that speaks just enough SMTP and keeps what it gets.
const inbox = [];
let smtp;
let smtpPort;

function startSmtp() {
  smtp = net.createServer((socket) => {
    let mail = null;
    let data = false;
    let buffer = '';
    socket.write('220 test relay\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            inbox.push(mail);
            socket.write('250 queued\r\n');
          } else {
            mail.lines.push(line);
          }
          continue;
        }
        if (/^EHLO /.test(line)) socket.write('250-test relay\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          socket.write(user === 'roost' && pass === 'relay-secret' ? '235 ok\r\n' : '535 bad login\r\n');
        } else if (/^MAIL FROM:/.test(line)) { mail = { from: line.slice(10), lines: [] }; socket.write('250 ok\r\n'); }
        else if (/^RCPT TO:/.test(line)) { mail.to = line.slice(8); socket.write('250 ok\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('500 what\r\n');
      }
    });
  });
  return new Promise((r) => smtp.listen(0, '127.0.0.1', () => { smtpPort = smtp.address().port; r(); }));
}

function bodyOf(m) {
  const blank = m.lines.indexOf('');
  return Buffer.from(m.lines.slice(blank + 1).join(''), 'base64').toString('utf8');
}

function header(m, name) {
  const line = m.lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line && line.slice(name.length + 1).trim();
}

const waitForMail = async (count) => {
  for (let i = 0; i < 50 && inbox.length < count; i++) await new Promise((r) => setTimeout(r, 20));
};

let server;
let base;
let dataDir;
let adminCookie;

before(async () => {
  await startSmtp();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-mail-'));
  server = createServer({ dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = (await call('POST', '/api/setup', { username: 'raven', password: 'correct horse', displayName: 'Raven' })).cookie;
});

after(() => {
  server.close();
  smtp.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

const relay = () => ({ host: '127.0.0.1', port: smtpPort, security: 'none', user: 'roost', password: 'relay-secret', from: 'server@roostos.network' });

test('mail settings are saved but the password is never sent back', async () => {
  const bad = await call('PATCH', '/api/admin/settings', { mail: { ...relay(), from: 'nope' } }, adminCookie);
  assert.equal(bad.status, 400);
  const res = await call('PATCH', '/api/admin/settings', { mail: relay() }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.mail.password, undefined);
  assert.equal(res.body.settings.mail.hasPassword, true);
  assert.ok(!JSON.stringify((await call('GET', '/api/admin/settings', null, adminCookie)).body).includes('relay-secret'));
  // Leaving the password blank keeps the saved one.
  await call('PATCH', '/api/admin/settings', { mail: { ...relay(), password: '' } }, adminCookie);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'roost.json'))).settings.mail.password, 'relay-secret');
});

test('email only counts as ready once the public address is set', async () => {
  assert.equal((await call('GET', '/api/state')).body.mailEnabled, false);
  await call('PATCH', '/api/admin/settings', { publicUrl: 'https://roostos.network' }, adminCookie);
  assert.equal((await call('GET', '/api/state')).body.mailEnabled, true);
});

test('a test email goes through the relay', async () => {
  assert.equal((await call('POST', '/api/admin/mail-test', {}, adminCookie)).status, 400);
  const res = await call('POST', '/api/admin/mail-test', { to: 'raven@example.com' }, adminCookie);
  assert.equal(res.status, 200);
  const m = inbox.at(-1);
  assert.equal(m.from, '<server@roostos.network>');
  assert.equal(m.to, '<raven@example.com>');
  assert.equal(header(m, 'From'), 'Roost <server@roostos.network>');
  assert.match(bodyOf(m), /Email is working/);
});

test('a wrong relay password is reported', async () => {
  await call('PATCH', '/api/admin/settings', { mail: { ...relay(), password: 'wrong' } }, adminCookie);
  const res = await call('POST', '/api/admin/mail-test', { to: 'raven@example.com' }, adminCookie);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /username or password/);
  await call('PATCH', '/api/admin/settings', { mail: relay() }, adminCookie);
});

test('users add an email on their profile, and each email is used once', async () => {
  assert.equal((await call('PATCH', '/api/me', { email: 'not an email' }, adminCookie)).status, 400);
  const ok = await call('PATCH', '/api/me', { email: 'Raven@Example.com' }, adminCookie);
  assert.equal(ok.body.user.email, 'raven@example.com');
});

test('an invite can be emailed, and the person can add their email when joining', async () => {
  const before = inbox.length;
  const made = await call('POST', '/api/admin/invites', { email: 'mum@example.com' }, adminCookie);
  assert.equal(made.body.emailedTo, 'mum@example.com');
  await waitForMail(before + 1);
  const m = inbox.at(-1);
  assert.equal(header(m, 'Subject'), "You're invited to Roost");
  assert.ok(bodyOf(m).includes(`https://roostos.network/j/${made.body.token}`));

  const dup = await call('POST', `/api/links/${made.body.token}`, { username: 'mum', password: 'long enough', email: 'raven@example.com' });
  assert.equal(dup.status, 409);
  const joined = await call('POST', `/api/links/${made.body.token}`, { username: 'mum', password: 'long enough', email: 'mum@example.com' });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.user.email, 'mum@example.com');
});

test('forgot password emails a 1-hour reset link without saying who exists', async () => {
  const before = inbox.length;
  const unknown = await call('POST', '/api/forgot', { login: 'nobody' });
  assert.equal(unknown.status, 200);
  const known = await call('POST', '/api/forgot', { login: 'MUM@example.com' });
  assert.deepEqual(known.body, unknown.body);
  await waitForMail(before + 1);
  assert.equal(inbox.length, before + 1);
  const m = inbox.at(-1);
  assert.equal(m.to, '<mum@example.com>');
  const url = bodyOf(m).match(/https:\/\/roostos\.network\/r\/(\S+)/);
  assert.ok(url);
  assert.match(bodyOf(m), /1 hour/);

  // Asking again straight away doesn't send another email.
  await call('POST', '/api/forgot', { login: 'mum' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(inbox.length, before + 1);

  const done = await call('POST', `/api/links/${url[1]}`, { password: 'a new password' });
  assert.equal(done.status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'mum', password: 'a new password' })).status, 200);
});

test('admins can email a reset link', async () => {
  const { body } = await call('GET', '/api/admin/users', null, adminCookie);
  const mum = body.users.find((u) => u.username === 'mum');
  const res = await call('POST', `/api/admin/users/${mum.id}/reset-link`, { email: true }, adminCookie);
  assert.equal(res.body.emailedTo, 'mum@example.com');
  assert.ok(bodyOf(inbox.at(-1)).includes(`/r/${res.body.token}`));
});

test('messages are base64 so no line can end the email early', () => {
  const msg = buildMessage({ from: 'a@b.co', fromName: 'Roost ✦', to: 'c@d.co', subject: 'Héllo', text: 'line\n.\nend' });
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.match(msg, /From: =\?UTF-8\?B\?.*\?= <a@b\.co>/);
  assert.ok(!/\r\n\.\r\n/.test(msg));
});
