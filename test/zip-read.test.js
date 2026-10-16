'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openZip } = require('../src/zip-read');
const { makeZip } = require('./zipmaker');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-zipread-'));
const readAll = async (zip, entry) => {
  const chunks = [];
  for await (const c of await zip.open(entry)) chunks.push(c);
  return Buffer.concat(chunks);
};

for (const zip64 of [false, true]) {
  test(`reads stored and deflated entries${zip64 ? ' (zip64 records)' : ''}`, async () => {
    const big = Buffer.alloc(300000, 'roost ');
    const file = path.join(dir, `a${zip64}.zip`);
    fs.writeFileSync(file, makeZip([
      { name: 'Takeout/', data: '' },
      { name: 'Takeout/ünï.txt', data: 'hello', deflate: true },
      { name: 'Takeout/big.bin', data: big, deflate: true },
      { name: 'Takeout/plain.bin', data: 'stored' },
      { name: 'Takeout/empty', data: '' },
    ], { zip64 }));
    const zip = await openZip(file);
    try {
      assert.deepEqual(zip.entries.map((e) => e.name), ['Takeout/', 'Takeout/ünï.txt', 'Takeout/big.bin', 'Takeout/plain.bin', 'Takeout/empty']);
      assert.equal(zip.entries[0].dir, true);
      assert.equal((await readAll(zip, zip.entries[1])).toString(), 'hello');
      assert.ok((await readAll(zip, zip.entries[2])).equals(big));
      assert.equal((await readAll(zip, zip.entries[3])).toString(), 'stored');
      assert.equal((await readAll(zip, zip.entries[4])).length, 0);
      assert.equal(new Date(zip.entries[1].mtime).getFullYear(), 2020);
    } finally {
      await zip.close();
    }
  });
}

test('a damaged entry is an error, not a bad file', async () => {
  const file = path.join(dir, 'bad.zip');
  const buf = makeZip([{ name: 'a.txt', data: 'abcdefgh' }]);
  buf[30 + 5 + 2] ^= 0xff; // flip a byte of the stored data
  fs.writeFileSync(file, buf);
  const zip = await openZip(file);
  await assert.rejects(readAll(zip, zip.entries[0]), /damaged/);
  await zip.close();
});

test('rejects files that are not zips or are cut short', async () => {
  const junk = path.join(dir, 'junk.zip');
  fs.writeFileSync(junk, Buffer.alloc(500, 1));
  await assert.rejects(openZip(junk), /not a zip/);
  const cut = path.join(dir, 'cut.zip');
  fs.writeFileSync(cut, makeZip([{ name: 'a.txt', data: 'x'.repeat(1000) }]).subarray(0, 600));
  await assert.rejects(openZip(cut), /zip|finish/);
  const tiny = path.join(dir, 'tiny.zip');
  fs.writeFileSync(tiny, 'PK');
  await assert.rejects(openZip(tiny), /not a zip/);
});

test('clean up', () => fs.rmSync(dir, { recursive: true, force: true }));
