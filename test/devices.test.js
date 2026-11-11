'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Devices, guessType } = require('../src/devices');
const { vendorOf, isPrivateMac } = require('../src/oui');

function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-devices-'));
  const lan = path.join(dir, 'lan');
  fs.mkdirSync(lan);
  let t = Date.parse('2026-11-12T10:00:00Z');
  const raised = [];
  const cleared = [];
  const findings = [];
  const make = () => new Devices({ dataDir: dir, lanDir: lan, raise: (k, title, detail) => raised.push({ k, title, detail }), clear: (k) => cleared.push(k), finding: (d) => findings.push(d), now: () => t });
  const d = make();
  let n = 0;
  const sweep = (hosts, extra = {}) => {
    n++;
    t += 30 * 60 * 1000;
    fs.writeFileSync(path.join(lan, 'lan.json'), JSON.stringify({ at: new Date(t).toISOString(), every: 30 * 60 * 1000, gateway: '192.168.4.1', self: '192.168.4.35', hosts, ...extra }));
    // The file's change time differs from the last one, as it does for a real sweep.
    fs.utimesSync(path.join(lan, 'lan.json'), new Date(t + n * 1000), new Date(t + n * 1000));
    d.refresh();
  };
  return { d, dir, lan, raised, cleared, findings, sweep, reopen: make, tick: (ms) => { t += ms; } };
}

const router = { ip: '192.168.4.1', mac: 'b0:a7:37:00:00:01', ports: [80, 443], mdns: null, dns: 'router' };
const server = { ip: '192.168.4.35', mac: 'b8:27:eb:00:00:35', ports: [8080, 8097], mdns: null, dns: null };
const phone = { ip: '192.168.4.20', mac: '3c:07:54:00:00:20', ports: [62078], mdns: 'Ravens-iPhone', dns: null };
const stranger = { ip: '192.168.4.61', mac: 'da:11:22:33:44:55', ports: [], mdns: null, dns: null };

test('the first sweep is a baseline: the router and this server are known, nothing alerts until you accept the list', () => {
  const m = make();
  m.sweep([router, server, phone, stranger]);
  m.sweep([router, server, phone, stranger]);
  const v = m.d.view();
  assert.equal(v.baselined, false);
  assert.equal(v.devices.length, 4);
  assert.equal(v.devices.find((x) => x.ip === '192.168.4.1').known, true);
  assert.equal(v.devices.find((x) => x.ip === '192.168.4.35').tag, 'server');
  assert.equal(m.raised.length, 0, 'no alerts before the baseline is accepted');
  m.d.markAllKnown();
  assert.equal(m.d.view().counts.new, 0);
  assert.equal(m.d.view().baselined, true);
});

test('a new device alerts once, after it is seen in two sweeps, and clears when named', () => {
  const m = make();
  m.sweep([router, server, phone]);
  m.d.markAllKnown();
  m.sweep([router, server, phone, stranger]);
  assert.equal(m.raised.length, 0, 'one sighting could be a passer-by');
  m.sweep([router, server, phone, stranger]);
  assert.equal(m.raised.length, 1);
  assert.equal(m.raised[0].k, `dev:new:${stranger.mac}`);
  assert.match(m.raised[0].detail, /192\.168\.4\.61/);
  m.sweep([router, server, phone, stranger]);
  assert.equal(m.raised.length, 1, 'only once');
  m.cleared.length = 0;
  m.d.update(stranger.mac, { label: 'Dad’s phone' });
  assert.deepEqual(m.cleared, [`dev:new:${stranger.mac}`]);
  const v = m.d.view();
  assert.equal(v.devices.find((x) => x.mac === stranger.mac).name, 'Dad’s phone');
  assert.equal(v.devices.find((x) => x.mac === stranger.mac).known, true);
});

test('a device that leaves shows as away, and "Not mine" forgets it', () => {
  const m = make();
  m.sweep([router, server, phone, stranger]);
  m.d.markAllKnown();
  m.sweep([router, server, phone]);
  const v = m.d.view();
  assert.equal(v.counts.online, 3);
  assert.equal(v.counts.away, 1);
  assert.equal(v.devices.find((x) => x.mac === stranger.mac).online, false);
  m.d.forget(stranger.mac);
  assert.equal(m.d.view().devices.length, 3);
  assert.throws(() => m.d.update('aa:aa:aa:aa:aa:aa', { label: 'x' }), /not in the list/);
});

test('the router’s address changing hands, or one card answering for two addresses, is a clash', () => {
  const m = make();
  m.sweep([router, server, phone]);
  m.d.markAllKnown();
  m.sweep([router, server, phone]);
  assert.equal(m.raised.length, 0);
  m.sweep([{ ...router, mac: 'da:11:22:33:44:99' }, server, phone]);
  assert.equal(m.raised.length, 1);
  assert.match(m.raised[0].title, /router/);
  assert.equal(m.findings.length, 1, 'Sentinel is told too');

  const two = make();
  two.sweep([router, server]);
  two.d.markAllKnown();
  two.sweep([router, server, { ip: '192.168.4.77', mac: router.mac, ports: [] }]);
  assert.equal(two.raised.length, 1);
  assert.match(two.raised[0].detail, /192\.168\.4\.77/);
});

test('risky open ports alert only when that rule is switched on', () => {
  const m = make();
  const camera = { ip: '192.168.4.47', mac: 'c0:56:e3:00:00:47', ports: [23, 80, 554], mdns: null, dns: null };
  m.sweep([router, server, camera]);
  m.d.markAllKnown();
  m.sweep([router, server, camera]);
  assert.equal(m.raised.length, 0, 'off by default');
  assert.equal(m.d.view().counts.watch, 1, 'but the list still marks it');
  m.d.setRules({ riskyPorts: true });
  m.sweep([router, server, camera]);
  assert.equal(m.raised.length, 1);
  assert.match(m.raised[0].title, /Telnet/);
  m.sweep([router, server, camera]);
  assert.equal(m.raised.length, 1);
});

test('rules can switch off new-device alerts', () => {
  const m = make();
  m.sweep([router, server]);
  m.d.markAllKnown();
  m.d.setRules({ newDevice: false });
  m.sweep([router, server, stranger]);
  m.sweep([router, server, stranger]);
  assert.equal(m.raised.length, 0);
});

test('names, labels and the list survive a restart', () => {
  const m = make();
  m.sweep([router, server, phone]);
  m.d.markAllKnown();
  m.d.update(phone.mac, { label: 'Raven’s iPhone', type: 'phone', tag: 'raven' });
  const again = m.reopen();
  const p = again.view().devices.find((x) => x.mac === phone.mac);
  assert.equal(p.name, 'Raven’s iPhone');
  assert.equal(p.tag, 'raven');
  assert.equal(again.view().baselined, true);
  assert.throws(() => again.update(phone.mac, { type: 'toaster' }), /Unknown type/);
});

test('names come from the device, then the maker; types are guessed from what it shows', () => {
  const m = make();
  m.sweep([router, server, phone, stranger]);
  const byIp = (ip) => m.d.view().devices.find((x) => x.ip === ip);
  assert.equal(byIp('192.168.4.20').name, 'Ravens-iPhone');
  assert.equal(byIp('192.168.4.20').type, 'phone');
  assert.equal(byIp('192.168.4.61').name, 'Unknown device (private address)');
  assert.equal(byIp('192.168.4.61').private, true);
  assert.equal(byIp('192.168.4.1').type, 'router');
  assert.equal(guessType({ names: ['Hisense-TV'] }), 'tv');
  assert.equal(guessType({ ports: [631] }), 'printer');
  assert.equal(guessType({ vendor: 'Hikvision', ports: [23] }), 'camera');
  assert.equal(guessType({ vendor: 'Espressif' }), 'home');
  assert.equal(guessType({ names: ['Ravens-iPad'], ports: [62078] }), 'tablet');
  assert.equal(guessType({}), 'other');
  assert.equal(vendorOf('b8:27:eb:11:22:33'), 'Raspberry Pi');
  assert.equal(vendorOf('da:27:eb:11:22:33'), null, 'a private address has no maker');
  assert.equal(isPrivateMac('da:27:eb:11:22:33'), true);
});

test('what a device is doing comes from what Roost knows, for online devices only', () => {
  const m = make();
  m.sweep([router, server, phone]);
  const doing = new Map([['192.168.4.20', 'Watching on Roostflix: Ep 4']]);
  assert.equal(m.d.view(doing).devices.find((x) => x.ip === '192.168.4.20').doing, 'Watching on Roostflix: Ep 4');
  m.sweep([router, server]);
  assert.equal(m.d.view(doing).devices.find((x) => x.ip === '192.168.4.20').doing, null);
});

test('the helper’s state: missing, ok, then stale', () => {
  const m = make();
  assert.equal(m.d.helper().state, 'missing');
  m.sweep([router, server]);
  assert.equal(m.d.helper().state, 'ok');
  m.tick(3 * 60 * 60 * 1000);
  assert.equal(m.d.helper().state, 'stale');
  assert.equal(m.d.view().devices.every((x) => !x.online), true, 'nothing is called online from an old sweep');
  assert.equal(new Devices({ dataDir: m.dir, lanDir: '' }).helper().state, 'off');
});

test('a failed sweep changes nothing', () => {
  const m = make();
  m.sweep([router, server, phone]);
  m.sweep([], { error: 'No home network found to scan' });
  assert.equal(m.d.view().devices.length, 3);
  assert.equal(m.d.helper().state, 'error');
});

test('asking for a sweep leaves a file, at most every 15 seconds; opening the page asks when the data is old', () => {
  const m = make();
  m.sweep([router, server]);
  assert.equal(m.d.requestScan(), true);
  assert.ok(fs.existsSync(path.join(m.lan, 'scan-now')));
  assert.equal(m.d.requestScan(), false);
  m.tick(20 * 1000);
  fs.unlinkSync(path.join(m.lan, 'scan-now'));
  m.d.autoScan();
  assert.equal(fs.existsSync(path.join(m.lan, 'scan-now')), false, 'a fresh sweep is left alone');
  m.tick(10 * 60 * 1000);
  m.d.autoScan();
  assert.equal(fs.existsSync(path.join(m.lan, 'scan-now')), true);
});
