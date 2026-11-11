'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { hostsOf, parseArp, parseGateway, pickNetwork, ptrQuery, parsePtrAnswer, openPorts, isPrivate } = require('../src/lan-scan');

test('only private ranges, never wider than a /22', () => {
  assert.equal(hostsOf('192.168.4.0/24').length, 254);
  assert.equal(hostsOf('192.168.4.77/24')[0], '192.168.4.1');
  assert.equal(hostsOf('10.1.0.0/22').length, 1022);
  assert.equal(hostsOf('10.0.0.0/16'), null);
  assert.equal(hostsOf('8.8.8.0/24'), null);
  assert.equal(hostsOf('172.32.0.0/24'), null);
  assert.equal(hostsOf('nonsense'), null);
  assert.ok(isPrivate('172.16.5.1') && !isPrivate('172.32.0.1') && !isPrivate('1.1.1.1'));
});

test('the ARP table gives IP and card address for complete entries only', () => {
  const text = 'IP address       HW type     Flags       HW address            Mask     Device\n'
    + '192.168.4.1      0x1         0x2         AA:BB:CC:00:11:22     *        eth0\n'
    + '192.168.4.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n'
    + '192.168.4.20     0x1         0x2         de:ad:be:ef:00:01     *        eth0\n';
  assert.deepEqual(parseArp(text).map((h) => [h.ip, h.mac]), [['192.168.4.1', 'aa:bb:cc:00:11:22'], ['192.168.4.20', 'de:ad:be:ef:00:01']]);
});

test('the default gateway is read from the route table', () => {
  assert.equal(parseGateway('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0104A8C0\t0003\neth0\t0004A8C0\t00000000\t0001\n'), '192.168.4.1');
  assert.equal(parseGateway('Iface\tDestination\tGateway\tFlags\n'), null);
});

test('Docker, VPN and loopback cards are skipped when picking the network', () => {
  const card = (address, netmask, mac = 'aa:bb:cc:dd:ee:ff') => [{ family: 'IPv4', address, netmask, mac, internal: false }];
  const n = pickNetwork({ docker0: card('172.17.0.1', '255.255.0.0'), wg0: card('10.9.0.1', '255.255.255.0'), eth0: card('192.168.4.35', '255.255.255.0') });
  assert.equal(n.name, 'eth0');
  assert.equal(n.cidr, '192.168.4.35/24');
  assert.equal(n.hosts.length, 254);
  // A big card sweeps the /24 around itself, not 65 thousand addresses.
  assert.equal(pickNetwork({ eth0: card('10.0.5.5', '255.255.0.0') }).hosts.length, 254);
  assert.equal(pickNetwork({ docker0: card('172.17.0.1', '255.255.0.0') }), null);
  assert.equal(pickNetwork({ eth0: card('192.168.4.35', '255.255.255.0') }, '8.8.8.0/24'), null, 'an outside range is refused');
});

// A reply to the PTR question: the question, then an answer that points back at it.
function answer(name) {
  const q = ptrQuery('192.168.4.20');
  const labels = name.split('.');
  const rdata = Buffer.concat([...labels.flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]), Buffer.from([0])]);
  const head = Buffer.from(q.subarray(0, 12));
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(1, 6);
  const fixed = Buffer.alloc(12);
  fixed.writeUInt16BE(0xc00c, 0);
  fixed.writeUInt16BE(12, 2);
  fixed.writeUInt16BE(1, 4);
  fixed.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, q.subarray(12), fixed, rdata]);
}

test('a device’s announced name is read from its answer', () => {
  assert.equal(parsePtrAnswer(answer('Ravens-iPhone.local')), 'Ravens-iPhone');
  assert.equal(parsePtrAnswer(Buffer.from([1, 2, 3])), null);
});

test('only open ports are listed, in order', async () => {
  const found = await openPorts(['192.168.4.1', '192.168.4.2'], [80, 23, 443], { connect: async (ip, port) => ip === '192.168.4.1' && port !== 443 });
  assert.deepEqual(found.get('192.168.4.1'), [23, 80]);
  assert.deepEqual(found.get('192.168.4.2'), []);
});
