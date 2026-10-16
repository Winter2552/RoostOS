'use strict';

// Builds small zip files for tests (stored or deflated, optionally with zip64
// records), so the zip reader and Move to Glint can be tested without a zip tool.

const zlib = require('zlib');
const fs = require('fs');

// entries: [{ name, data: Buffer|string, deflate?: bool, mtime?: ms }]
function makeZip(entries, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data === undefined ? '' : e.data);
    const body = e.deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const d = new Date(e.mtime || Date.UTC(2020, 5, 15, 12, 0, 0));
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(zip64 ? 45 : 20, 4);
    cen.writeUInt16LE(zip64 ? 45 : 20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    let extra = Buffer.alloc(0);
    if (zip64) {
      cen.writeUInt32LE(0xffffffff, 20);
      cen.writeUInt32LE(0xffffffff, 24);
      cen.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    } else {
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt32LE(offset, 42);
    }
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    central.push(cen, name, extra);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    end.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  end.push(eocd);
  return Buffer.concat([...parts, cd, ...end]);
}

function writeZip(file, entries, opts) {
  fs.writeFileSync(file, makeZip(entries, opts));
}

module.exports = { makeZip, writeZip };
