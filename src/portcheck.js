'use strict';

// "Which doors are open?": Roost tries a handful of well-known ports on its own
// public address, the way someone scanning the internet would. It only runs
// when an admin presses the button, never on a timer. It tests from inside the
// network, so it can't tell a real open door from a router answering for its
// own public address (many routers show their admin page on port 80 that way).
// For that reason it also asks each open port who answered, so you can judge.

const net = require('net');

const PORTS = [
  { port: 21, name: 'FTP' }, { port: 22, name: 'SSH' }, { port: 23, name: 'Telnet' }, { port: 25, name: 'Mail' },
  { port: 80, name: 'Web (HTTP)' }, { port: 139, name: 'Windows sharing' }, { port: 445, name: 'Windows sharing' },
  { port: 2375, name: 'Docker' }, { port: 3389, name: 'Remote Desktop' }, { port: 5000, name: 'NAS web' },
  { port: 5900, name: 'VNC' }, { port: 8080, name: 'Roost (home address)' }, { port: 8096, name: 'Jellyfin' },
  { port: 8097, name: 'Jellyfin' }, { port: 8443, name: 'Roost (secure, internal)' }, { port: 9000, name: 'Web admin' },
  { port: 32400, name: 'Plex' },
];
// The one door that is meant to be open.
const EXPECTED = new Set([443]);

function probe(host, port, timeoutMs, connect = net.connect) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Who answered? The first line of its greeting, or an HTTP Server header.
function banner(host, port, timeoutMs, connect = net.connect) {
  return new Promise((resolve) => {
    let text = '';
    const socket = connect({ host, port });
    const done = () => {
      socket.destroy();
      const server = /^server:\s*(.+)$/im.exec(text);
      const first = text.split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '').slice(0, 60);
      resolve(server ? `${first} · ${server[1].trim().slice(0, 40)}` : first);
    };
    socket.setTimeout(Math.min(timeoutMs, 1500), done);
    socket.once('connect', () => socket.write('HEAD / HTTP/1.0\r\n\r\n'));
    socket.on('data', (d) => { text += d.toString('latin1'); if (text.length > 600 || /\r?\n\r?\n/.test(text)) done(); });
    socket.once('error', done);
    socket.once('close', done);
  });
}

// → { ip, at, open: [{ port, name, banner? }], tried }
async function checkPorts(ip, { timeoutMs = 2500, connect, now = Date.now, ports = [{ port: 443, name: 'Roost (HTTPS)' }, ...PORTS] } = {}) {
  const results = await Promise.all(ports.map(async (p) => ({ ...p, open: await probe(ip, p.port, timeoutMs, connect) })));
  const open = await Promise.all(results.filter((r) => r.open).map(async ({ port, name }) => {
    const said = port === 443 ? '' : await banner(ip, port, timeoutMs, connect);
    return said ? { port, name, banner: said } : { port, name };
  }));
  return { ip, at: now(), tried: ports.length, open };
}

module.exports = { checkPorts, probe, PORTS, EXPECTED };
