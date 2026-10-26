'use strict';

// "Which doors are open?": Roost tries a handful of well-known ports on its own
// public address, the way someone scanning the internet would. It only runs
// when an admin presses the button, never on a timer. It tests from inside the
// network, so a router that can't loop back makes a closed door look closed
// even if it isn't; an open one is always worth a look.

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

// → { ip, at, open: [{ port, name }], tried }
async function checkPorts(ip, { timeoutMs = 2500, connect, now = Date.now, ports = [{ port: 443, name: 'Roost (HTTPS)' }, ...PORTS] } = {}) {
  const results = await Promise.all(ports.map(async (p) => ({ ...p, open: await probe(ip, p.port, timeoutMs, connect) })));
  return { ip, at: now(), tried: ports.length, open: results.filter((r) => r.open).map(({ port, name }) => ({ port, name })) };
}

module.exports = { checkPorts, probe, PORTS, EXPECTED };
