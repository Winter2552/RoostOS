'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { recent, decodeWords, snippet } = require('../src/mailbox');

const MAILS = [
  { from: 'Sam <sam@example.com>', subject: '=?utf-8?B?Q2Fmw6k=?= tonight?', date: 'Sun, 1 Nov 2026 18:00:00 +0000', text: 'Hi Raven,\r\nAre you free at 7?\r\n' },
  { from: 'Octopus Energy <hello@octo.example>', subject: 'Your bill is ready', date: 'Sun, 1 Nov 2026 19:00:00 +0000', text: '--b1\r\nContent-Type: text/plain\r\n\r\nYour bill is =C2=A342.10 due 20 Nov.\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--b1--\r\n' },
];

function fakeServer(log) {
  return net.createServer((socket) => {
    socket.write('* OK ready\r\n');
    let buf = '';
    socket.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(' ');
        log.push(line.replace(/"[^"]*" "[^"]*"/, '"user" "pass"'));
        if (cmd === 'LOGIN') socket.write(line.includes('"good"') ? `${tag} OK logged in\r\n` : `${tag} NO nope\r\n`);
        else if (cmd === 'EXAMINE') socket.write(`* 2 EXISTS\r\n${tag} OK [READ-ONLY] done\r\n`);
        else if (cmd === 'SEARCH') socket.write(`* SEARCH 1 2\r\n${tag} OK done\r\n`);
        else if (cmd === 'FETCH') {
          let out = '';
          MAILS.forEach((m, n) => {
            const head = `From: ${m.from}\r\nSubject: ${m.subject}\r\nDate: ${m.date}\r\n\r\n`;
            out += `* ${n + 1} FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(head)}}\r\n${head} BODY[TEXT]<0> {${Buffer.byteLength(m.text)}}\r\n${m.text})\r\n`;
          });
          socket.write(`${out}${tag} OK done\r\n`);
        } else socket.write(`${tag} OK\r\n`);
      }
    });
  });
}

test('lists the newest mail read-only, newest first, with decoded words and snippets', async () => {
  const log = [];
  const server = fakeServer(log);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const mails = await recent({ host: '127.0.0.1', port: server.address().port, secure: false, user: 'raven', pass: 'good', count: 5 });
    assert.equal(mails.length, 2);
    assert.equal(mails[0].from, 'Octopus Energy <hello@octo.example>');
    assert.equal(mails[0].snippet, 'Your bill is £42.10 due 20 Nov.');
    assert.equal(mails[1].subject, 'Café tonight?');
    assert.equal(mails[1].snippet, 'Hi Raven, Are you free at 7?');
    assert.ok(log.some((l) => l.includes('EXAMINE INBOX')), 'opened read-only');
    assert.ok(!log.some((l) => /\bSELECT\b|STORE|DELETE|EXPUNGE|APPEND/.test(l)), 'never changes anything');
    assert.ok(log.some((l) => l.includes('BODY.PEEK')), 'does not mark as read');
  } finally {
    server.close();
  }
});

test('a wrong password gives a plain message', async () => {
  const server = fakeServer([]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(recent({ host: '127.0.0.1', port: server.address().port, secure: false, user: 'raven', pass: 'bad' }), /refused the sign-in/);
  } finally {
    server.close();
  }
});

test('helpers', () => {
  assert.equal(decodeWords('=?utf-8?Q?Caf=C3=A9_menu?='), 'Café menu');
  assert.equal(snippet('<p>Hello&nbsp;<b>there</b></p>'), 'Hello there');
});
