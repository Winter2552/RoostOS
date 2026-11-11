'use strict';

// Who made a network card, from the first three bytes of its address. This is a
// short starter list of makers common in homes, kept in the repo so Roost never
// asks anyone outside (the full registry is about 5 MB). A maker that isn't here
// just shows as unknown; add a line to extend it. Phones that use a private
// (random) address show no maker at all, on purpose: see isPrivateMac.

const MAKERS = {
  Apple: ['00:03:93', '00:0A:95', '00:11:24', '00:17:F2', '00:1B:63', '00:1C:B3', '00:1E:C2', '00:23:12', '00:25:00', '00:26:BB', '28:CF:E9', '3C:07:54', '40:6C:8F', '60:F8:1D', '70:56:81', '78:31:C1', '7C:6D:62', '84:38:35', '88:66:A5', '8C:85:90', 'A4:5E:60', 'AC:BC:32', 'B8:E8:56', 'BC:52:B7', 'D0:03:4B', 'F0:18:98', 'F4:5C:89'],
  Samsung: ['00:12:47', '00:15:99', '00:16:32', '00:17:D5', '00:1A:8A', '00:21:19', '08:D4:2B', '18:3A:2D', '38:AA:3C', '5C:0A:5B', '78:47:1D', '8C:77:12', 'A0:82:1F', 'BC:72:B1', 'CC:07:AB', 'E4:7C:F9'],
  Google: ['3C:5A:B4', '54:60:09', '6C:AD:F8', '94:EB:2C', 'A4:77:33', 'F4:F5:D8', 'F8:8F:CA', '1C:F2:9A', '30:FD:38', '48:D6:D5'],
  Amazon: ['00:FC:8B', '0C:47:C9', '34:D2:70', '40:B4:CD', '44:65:0D', '68:54:FD', '74:C2:46', 'A0:02:DC', 'F0:F0:A4', 'FC:65:DE', '50:DC:E7'],
  'Raspberry Pi': ['B8:27:EB', 'DC:A6:32', 'E4:5F:01', 'D8:3A:DD', '2C:CF:67'],
  Espressif: ['24:0A:C4', '24:6F:28', '30:AE:A4', '3C:71:BF', '5C:CF:7F', '60:01:94', '68:C6:3A', '7C:9E:BD', '84:F3:EB', 'A4:CF:12', 'BC:DD:C2', 'CC:50:E3', 'EC:FA:BC', '18:FE:34'],
  'TP-Link': ['14:CC:20', '50:C7:BF', '60:E3:27', '98:DA:C4', 'A0:F3:C1', 'EC:08:6B', 'F4:F2:6D', '30:B5:C2'],
  Netgear: ['00:09:5B', '00:0F:B5', '00:14:6C', '20:4E:7F', 'A0:40:A0', 'C4:04:15'],
  Ubiquiti: ['24:5A:4C', '44:D9:E7', '78:8A:20', 'B4:FB:E4', 'FC:EC:DA'],
  Sonos: ['00:0E:58', '48:A6:B8', '5C:AA:FD', '78:28:CA', '94:9F:3E', 'B8:E9:37'],
  Signify: ['00:17:88', 'EC:B5:FA'],
  Hikvision: ['28:57:BE', '44:19:B6', '4C:BD:8F', 'A4:14:37', 'BC:AD:28', 'C0:56:E3'],
  Dell: ['00:14:22', '00:1A:A0', '14:B3:1F', '18:03:73', '34:17:EB', 'B8:CA:3A', 'D4:AE:52', 'F8:BC:12'],
  Intel: ['00:1B:21', '3C:97:0E', '8C:8D:28', 'A4:34:D9', 'B4:6B:FC'],
  HP: ['00:1F:29', '3C:D9:2B', '94:57:A5', 'A0:D3:C1'],
  Microsoft: ['28:18:78', '7C:ED:8D', '98:5F:D3'],
  Sony: ['00:04:1F', '00:13:A9', '70:9E:29', 'FC:0F:E6', '00:D9:D1'],
  Nintendo: ['00:09:BF', '00:17:AB', '7C:BB:8A', '98:B6:E9', 'E8:4E:CE'],
  LG: ['00:1C:62', '00:1E:75', 'A8:23:FE', 'C4:36:6C'],
  Canon: ['00:1E:8F', '18:0C:AC'],
  Brother: ['00:80:77', '30:05:5C'],
  Epson: ['00:26:AB', '38:9D:92'],
  Xiaomi: ['28:6C:07', '64:09:80', '78:11:DC'],
  Huawei: ['00:E0:FC', '28:6E:D4', '48:46:FB'],
  Asus: ['00:0C:6E', '04:D4:C4', '2C:56:DC', '50:46:5D'],
  Roku: ['00:0D:4B', 'B0:A7:37', 'D8:31:34'],
};

const TABLE = new Map();
for (const [maker, prefixes] of Object.entries(MAKERS)) for (const p of prefixes) TABLE.set(p.toLowerCase(), maker);

// A random address a phone or laptop makes up for each network. Its second
// hex digit is 2, 6, A or E (the "locally administered" bit).
function isPrivateMac(mac) {
  const n = parseInt(String(mac).slice(1, 2), 16);
  return Number.isInteger(n) && (n & 2) === 2;
}

function vendorOf(mac) {
  if (!mac || isPrivateMac(mac)) return null;
  return TABLE.get(String(mac).slice(0, 8).toLowerCase()) || null;
}

module.exports = { vendorOf, isPrivateMac };
