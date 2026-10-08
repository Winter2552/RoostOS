'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { judge, DriveHealth, STALE_MS } = require('../src/smart');
const { STEPS } = require('../src/setup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-smart-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Trimmed from real `smartctl --all --json` output (smartmontools 7.4).
const attr = (id, raw, value = 100) => ({ id, value, worst: value, thresh: 0, raw: { value: raw, string: String(raw) } });

function sataSsd(over = {}) {
  return {
    device: { name: '/dev/sda', type: 'sat', protocol: 'ATA' },
    model_name: 'KINGSTON SA400S37240G',
    serial_number: '50026B7782',
    user_capacity: { blocks: 468862128, bytes: 240057409536 },
    logical_block_size: 512,
    rotation_rate: 0,
    smart_status: { passed: true },
    temperature: { current: 34 },
    power_on_time: { hours: 9120 },
    ata_smart_attributes: { table: [attr(5, 0), attr(187, 0), attr(231, 0, 93)] },
    ata_device_statistics: {
      pages: [
        { number: 1, name: 'General Statistics', table: [{ name: 'Logical Sectors Written', value: 20000000000 }] },
      ],
    },
    ...over,
  };
}

function hdd(table = [], over = {}) {
  return {
    device: { name: '/dev/sdb', type: 'sat', protocol: 'ATA' },
    model_name: 'WDC WD30EFZX-68AWUN0',
    user_capacity: { bytes: 3000592982016 },
    rotation_rate: 5400,
    smart_status: { passed: true },
    temperature: { current: 38 },
    power_on_time: { hours: 120 },
    ata_smart_attributes: { table: [attr(5, 0), attr(197, 0), attr(198, 0), attr(199, 0), ...table] },
    ...over,
  };
}

const nvme = (log = {}) => ({
  device: { name: '/dev/nvme0n1', type: 'nvme', protocol: 'NVMe' },
  model_name: 'Samsung SSD 970 EVO 500GB',
  nvme_total_capacity: 500107862016,
  smart_status: { passed: true },
  nvme_smart_health_information_log: {
    critical_warning: 0, temperature: 41, available_spare: 100, available_spare_threshold: 10,
    percentage_used: 3, data_units_written: 1000000, power_on_hours: 400, media_errors: 0, ...log,
  },
});

test('a healthy SSD reads as healthy, with its wear and data written', () => {
  const d = judge(sataSsd());
  assert.equal(d.kind, 'SSD');
  assert.equal(d.verdict, 'good');
  assert.equal(d.headline, 'Healthy');
  assert.deepEqual(d.reasons, []);
  assert.equal(d.details.wear, 7);
  assert.equal(d.details.written, 20000000000 * 512);
  assert.equal(d.details.hours, 9120);
  assert.equal(d.capacity, 240057409536);
});

test('the wear figure comes from wherever the drive reports it', () => {
  const stat = sataSsd({
    ata_device_statistics: { pages: [{ name: 'Solid State Device Statistics', table: [{ name: 'Percentage Used Endurance Indicator', value: 12 }] }] },
  });
  assert.equal(judge(stat).details.wear, 12);
  assert.equal(judge(sataSsd({ endurance_used: { current_percent: 4 } })).details.wear, 4);
  assert.equal(judge(nvme()).details.wear, 3);
  assert.equal(judge(nvme()).details.written, 1000000 * 512000);
});

test('a worn SSD is flagged, then marked for replacing', () => {
  assert.equal(judge(nvme({ percentage_used: 85 })).verdict, 'watch');
  const worn = judge(nvme({ percentage_used: 97 }));
  assert.equal(worn.verdict, 'bad');
  assert.equal(worn.headline, 'Replace soon');
  assert.match(worn.reasons[0], /97% of its rated life/);
});

test('bad sectors on a hard drive', () => {
  const d = judge(hdd([], { ata_smart_attributes: { table: [attr(5, 8), attr(197, 0)] } }));
  assert.equal(d.kind, 'HDD');
  assert.equal(d.verdict, 'watch');
  assert.equal(d.headline, 'Keep an eye on it');
  assert.equal(d.reasons[0], '8 worn-out sectors replaced');
  const failing = judge(hdd([], { ata_smart_attributes: { table: [attr(5, 8), attr(197, 1)] } }));
  assert.equal(failing.verdict, 'bad');
  assert.equal(failing.headline, 'Replace soon');
  // Worst reason first.
  assert.equal(failing.reasons[0], '1 sector can’t be read');
});

test('cable errors are shown but never judged, since they never reset', () => {
  const d = judge(hdd([], { ata_smart_attributes: { table: [attr(199, 40)] } }));
  assert.equal(d.verdict, 'good');
  assert.equal(d.details.cableErrors, 40);
});

test('heat alone says to cool it down, not to replace the drive', () => {
  assert.equal(judge(hdd([], { temperature: { current: 52 } })).headline, 'Keep an eye on it');
  const hot = judge(hdd([], { temperature: { current: 61 } }));
  assert.equal(hot.verdict, 'bad');
  assert.equal(hot.headline, 'Cool it down');
  // An SSD runs warmer than a hard drive before it matters.
  assert.equal(judge(sataSsd({ temperature: { current: 55 } })).verdict, 'good');
});

test('a failed self-check is always bad', () => {
  const d = judge(sataSsd({ smart_status: { passed: false } }));
  assert.equal(d.verdict, 'bad');
  assert.equal(d.headline, 'Replace soon');
  assert.equal(judge(nvme({ critical_warning: 4 })).verdict, 'bad');
});

test('the helper folder becomes one entry per drive', () => {
  const dir = path.join(tmp, 'folder');
  fs.mkdirSync(dir);
  const health = new DriveHealth(dir);
  // Nothing yet: say we are waiting rather than show nothing.
  assert.deepEqual(health.read(), { drives: [], checkedAt: null, stale: true });

  fs.writeFileSync(path.join(dir, 'sda.json'), JSON.stringify(sataSsd()));
  fs.writeFileSync(path.join(dir, 'sdb.json'), JSON.stringify(hdd()));
  fs.writeFileSync(path.join(dir, 'sdb.asleep'), '');
  fs.writeFileSync(path.join(dir, 'sdc.error'), 'Smartctl open device: /dev/sdc failed');
  fs.writeFileSync(path.join(dir, 'checked'), new Date().toISOString());
  fs.writeFileSync(path.join(dir, '.sdd.tmp'), '{');
  const read = health.read();
  assert.equal(read.stale, false);
  assert.deepEqual(read.drives.map((d) => [d.device, d.verdict]), [['sda', 'good'], ['sdb', 'good'], ['sdc', 'unknown']]);
  assert.equal(read.drives[1].asleep, true);
  assert.equal(read.drives[2].headline, 'Can’t tell');

  // Unchanged files are not parsed again.
  assert.equal(health.read().drives[0], read.drives[0]);
  fs.writeFileSync(path.join(dir, 'sda.json'), JSON.stringify(sataSsd({ smart_status: { passed: false } })));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'sda.json'), later, later);
  assert.equal(health.read().drives[0].verdict, 'bad');

  // An old "checked" means the helper has stopped.
  fs.writeFileSync(path.join(dir, 'checked'), new Date(Date.now() - STALE_MS - 1000).toISOString());
  assert.equal(health.read().stale, true);
});

test('no folder set means drive health is off', () => {
  assert.equal(new DriveHealth('').read(), null);
  assert.equal(new DriveHealth(path.join(tmp, 'nope')).read().missing, true);
});

test('the setup step ticks once every drive has a reading', () => {
  const step = STEPS.find((s) => s.id === 'drive-health');
  const drives = [{ label: 'System' }, { label: 'Data' }];
  const good = { verdict: 'good' };
  assert.equal(step.check({ drives, driveHealth: null }), false);
  assert.equal(step.check({ drives, driveHealth: { drives: [good] } }), false);
  assert.equal(step.check({ drives, driveHealth: { drives: [good, { verdict: 'unknown' }] } }), false);
  assert.equal(step.check({ drives, driveHealth: { drives: [good, { verdict: 'watch' }] } }), true);
});

test('the helper script saves readings, keeps a sleeping drive asleep, and records errors', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp, 'script');
  const bin = path.join(dir, 'bin');
  const out = path.join(dir, 'out');
  fs.mkdirSync(bin, { recursive: true });
  // A stand-in smartctl: sda answers, sdb is asleep (exit 3), sdc can't be opened.
  fs.writeFileSync(path.join(bin, 'smartctl'), `#!/bin/sh
for a; do dev=$a; done
case $dev in
  */sda) echo '{"model_name":"A","rotation_rate":0}'; exit 4 ;;
  */sdb) echo 'Device is in STANDBY mode, exit(3)'; exit 3 ;;
  *) echo 'open failed'; exit 2 ;;
esac
`, { mode: 0o755 });
  // sdb has an older reading, which must survive its nap.
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'sdb.json'), '{"model_name":"B"}');
  const devs = ['sda', 'sdb', 'sdc'].map((d) => path.join(dir, d));
  devs.forEach((d) => fs.writeFileSync(d, ''));
  execFileSync('sh', [path.join(__dirname, '..', 'smart', 'check.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out, DEVICES: devs.join(' '), ONCE: '1' },
  });
  // Exit 4 is a finding about the drive, not a failed read.
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'sda.json'), 'utf8')).model_name, 'A');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'sdb.json'), 'utf8')).model_name, 'B');
  assert.ok(fs.existsSync(path.join(out, 'sdb.asleep')));
  assert.ok(fs.existsSync(path.join(out, 'sdc.error')));
  assert.ok(!fs.existsSync(path.join(out, 'sdc.json')));
  assert.ok(!Number.isNaN(new Date(fs.readFileSync(path.join(out, 'checked'), 'utf8').trim()).getTime()));
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith('.')), []);
});

test('the status page carries drive health when the helper is set up', async () => {
  const { createServer } = require('../src/server');
  const smartDir = path.join(tmp, 'server-smart');
  fs.mkdirSync(smartDir);
  fs.writeFileSync(path.join(smartDir, 'sda.json'), JSON.stringify(sataSsd()));
  fs.writeFileSync(path.join(smartDir, 'checked'), new Date().toISOString());
  const dataDir = path.join(tmp, 'server-data');
  const server = createServer({ dataDir, smartDir, probeTimeoutMs: 200, dockerHost: 'tcp://127.0.0.1:1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'raven', password: 'correct horse' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const body = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(body.driveHealth.drives.map((d) => [d.device, d.headline]), [['sda', 'Healthy']]);
  } finally {
    server.close();
  }
});
