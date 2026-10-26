'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Sensors, parse, estimateWatts, priceOf, money, costs, DEFAULT_PRICE } = require('../src/sensors');
const { DriveHealth } = require('../src/smart');
const { STEPS } = require('../src/setup');
const { setUpTwoStep } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sensors-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('the sensors file parses into key/value pairs', () => {
  assert.deepEqual(parse('at=2026-10-26T10:00:00Z\npower_mw=8200\n\nnonsense'), { at: '2026-10-26T10:00:00Z', power_mw: '8200' });
});

test('the whole-box estimate adds the board and each spinning hard drive', () => {
  assert.equal(estimateWatts(8, 0), 14);
  assert.equal(estimateWatts(8, 1), 18);
});

test('money reads naturally in pence and pounds', () => {
  assert.equal(money(0.6, '£'), '0.6p');
  assert.equal(money(26.84, '£'), '27p');
  assert.equal(money(150, '£'), '£1.50');
  assert.equal(money(0.5, '$'), '0.5¢');
  assert.equal(money(2, 'kr'), 'kr2.00');
});

test('cost follows the saved price, and starts at 26.84p per kWh', () => {
  assert.equal(priceOf({}).price, DEFAULT_PRICE);
  assert.deepEqual(priceOf({ energyPrice: 30, energyCurrency: '€' }), { price: 30, currency: '€' });
  // 20 W for an hour is 0.02 kWh = 0.5368p.
  const c = costs(20, priceOf({}));
  assert.equal(c.perHour, '0.5p');
  assert.equal(c.perDay, '13p');
  assert.equal(c.perMonth, '£3.92');
});

test('view turns a reading into tiles and leaves out what is missing', () => {
  const dir = path.join(tmp, 'view');
  const at = new Date().toISOString();
  write(path.join(dir, 'sensors'), `at=${at}\npower_mw=9500\ncpu_temp_mc=47000\n`);
  const view = new Sensors(dir).view({
    driveHealth: { drives: [
      { device: 'sda', kind: 'SSD', model: 'SSD', asleep: false, details: { temp: 36 } },
      { device: 'sdb', kind: 'HDD', model: 'Big', asleep: false, details: { temp: 41 } },
    ] },
  });
  assert.equal(view.power.cpuWatts, 9.5);
  assert.equal(view.power.watts, 19.5); // 9.5 + 6 board + 4 for the spinning HDD
  assert.equal(view.cpuTemp, 47);
  assert.equal(view.fanRpm, null);
  assert.deepEqual(view.hottestDrive, { name: 'Big', temp: 41 });
  assert.equal(view.stale, false);

  // A sleeping hard drive adds nothing.
  const asleep = new Sensors(dir).view({ driveHealth: { drives: [{ device: 'sdb', kind: 'HDD', asleep: true, details: {} }] } });
  assert.equal(asleep.power.watts, 15.5);
});

test('no helper, no file, and an old file are told apart', () => {
  assert.equal(new Sensors('').view(), null);
  assert.deepEqual(new Sensors(path.join(tmp, 'nothing-here')).view(), { missing: true });
  const dir = path.join(tmp, 'old');
  write(path.join(dir, 'sensors'), `at=${new Date(Date.now() - 10 * 60 * 1000).toISOString()}\ncpu_temp_mc=40000\n`);
  const view = new Sensors(dir).view();
  assert.equal(view.stale, true);
  assert.equal(view.power, null);
  assert.equal(view.cpuTemp, 40);
});

test('the helper writes watts from the CPU counter and the hottest CPU sensor', () => {
  const sys = path.join(tmp, 'sys');
  const out = path.join(tmp, 'helper-out');
  const rapl = path.join(sys, 'class/powercap/intel-rapl:0');
  write(path.join(rapl, 'energy_uj'), '1000000000');
  write(path.join(rapl, 'max_energy_range_uj'), '262143328850');
  write(path.join(sys, 'class/hwmon/hwmon0/name'), 'coretemp\n');
  write(path.join(sys, 'class/hwmon/hwmon0/temp1_input'), '43000\n');
  write(path.join(sys, 'class/hwmon/hwmon0/temp2_input'), '51000\n');
  write(path.join(sys, 'class/hwmon/hwmon1/name'), 'nvme\n');
  write(path.join(sys, 'class/hwmon/hwmon1/temp1_input'), '90000\n');
  const env = { ...process.env, OUT: out, SYS: sys, DEVICES: path.join(tmp, 'no-such-drive'), ONCE: '1' };
  const run = () => execFileSync('sh', [path.join(__dirname, '..', 'smart', 'check.sh')], { env });

  run();
  let first = parse(fs.readFileSync(path.join(out, 'sensors'), 'utf8'));
  assert.equal(first.cpu_temp_mc, '51000'); // not the NVMe's 90 °C
  assert.equal(first.power_mw, undefined); // one sample can't give a rate yet
  assert.equal(first.fan_rpm, undefined);

  // Pretend the first reading was 10 s ago and 100 J (100,000,000 µJ) have passed.
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(out, '.rapl'), `1000000000 ${now - 10}\n`);
  write(path.join(rapl, 'energy_uj'), '1100000000');
  run();
  const second = parse(fs.readFileSync(path.join(out, 'sensors'), 'utf8'));
  assert.ok(Math.abs(Number(second.power_mw) - 10000) < 2000, `got ${second.power_mw}`);

  // The counter wrapped around: 100 J on, across the maximum.
  fs.writeFileSync(path.join(out, '.rapl'), `262143328850 ${now - 10}\n`);
  write(path.join(rapl, 'energy_uj'), '99999999');
  run();
  const wrapped = parse(fs.readFileSync(path.join(out, 'sensors'), 'utf8'));
  assert.ok(Number(wrapped.power_mw) > 0 && Number(wrapped.power_mw) < 30000, `got ${wrapped.power_mw}`);
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith('.') && n !== '.rapl'), []);
});

test('a machine with no sensors leaves only the timestamp', () => {
  const out = path.join(tmp, 'bare-out');
  execFileSync('sh', [path.join(__dirname, '..', 'smart', 'check.sh')], {
    env: { ...process.env, OUT: out, SYS: path.join(tmp, 'empty-sys'), DEVICES: path.join(tmp, 'none'), ONCE: '1' },
  });
  assert.deepEqual(Object.keys(parse(fs.readFileSync(path.join(out, 'sensors'), 'utf8'))), ['at']);
});

test('the sensors file is not mistaken for a drive', () => {
  const dir = path.join(tmp, 'mixed');
  write(path.join(dir, 'sensors'), 'at=2026-10-26T10:00:00Z\n');
  write(path.join(dir, 'checked'), new Date().toISOString());
  assert.deepEqual(new DriveHealth(dir).read().drives, []);
});

test('Admin → Setup has a power and heat step that reads the sensors', () => {
  const step = STEPS.find((s) => s.id === 'power-heat');
  assert.ok(step && step.optional);
  assert.equal(step.check({ sensors: null }), false);
  assert.equal(step.check({ sensors: { missing: true } }), false);
  assert.equal(step.check({ sensors: { power: null, cpuTemp: 40 } }), true);
  assert.equal(step.check({ sensors: { power: { watts: 12 }, cpuTemp: null } }), true);
});

test('the status page and settings carry power and the electricity price for admins', async () => {
  const { createServer } = require('../src/server');
  const smartDir = path.join(tmp, 'srv-smart');
  write(path.join(smartDir, 'sensors'), `at=${new Date().toISOString()}\npower_mw=10000\ncpu_temp_mc=45000\n`);
  const server = createServer({ dataDir: path.join(tmp, 'srv-data'), smartDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = { 'Content-Type': 'application/json' };
    const res = await fetch(`${base}/api/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'raven', password: 'correct horse' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const status = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(status.sensors.power.watts, 16); // 10 W CPU + 6 W board
    assert.equal(status.sensors.cpuTemp, 45);

    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { ...json, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    await setUpTwoStep(call, cookie);
    const settings = await call('GET', '/api/admin/settings');
    assert.equal(settings.body.settings.energyPrice, DEFAULT_PRICE);
    assert.equal(settings.body.settings.energyCurrency, '£');

    const saved = await call('PATCH', '/api/admin/settings', { energyPrice: '30.5', energyCurrency: '€' });
    assert.equal(saved.body.settings.energyPrice, 30.5);
    const priced = await call('GET', '/api/status');
    assert.equal(priced.body.sensors.power.perHour, '0.5c'); // 16 W at 30.5c per kWh
    assert.equal((await call('PATCH', '/api/admin/settings', { energyPrice: '-1' })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/settings', { energyPrice: '' })).body.settings.energyPrice, DEFAULT_PRICE);
  } finally {
    server.close();
  }
});
