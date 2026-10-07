'use strict';

// Streams a zip of files straight from disk, for downloading folders.
//
// Entries are stored, not compressed: photos, videos and most documents are
// already compressed, so deflating them would burn CPU for almost nothing.
// Sizes are known up front, so the total length is too, which lets browsers
// show download progress. The CRC is worked out while streaming and written
// after each file (a data descriptor), so every file is read only once.
// Zip64 fields are added only where a size or offset needs them.

const fs = require('fs');
const zlib = require('zlib');

const MAX32 = 0xffffffff;

function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name: 'folder/file.txt' | 'folder/', file: '/abs/path' | null, size, mtime }]
function plan(entries) {
  let offset = 0;
  const items = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8');
    const dir = !e.file;
    const size = dir ? 0 : e.size;
    const zip64 = size >= MAX32;
    const item = { ...e, nameBuf: name, dir, size, zip64, offset, ...dosDateTime(e.mtime) };
    const localLen = 30 + name.length + (zip64 ? 20 : 0);
    const descLen = dir ? 0 : zip64 ? 24 : 16;
    offset += localLen + size + descLen;
    return item;
  });
  const cdOffset = offset;
  let cdSize = 0;
  for (const it of items) {
    const extra = (it.zip64 ? 16 : 0) + (it.offset >= MAX32 ? 8 : 0);
    it.centralExtra = extra ? extra + 4 : 0;
    cdSize += 46 + it.nameBuf.length + it.centralExtra;
  }
  const zip64End = items.length > 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  const total = cdOffset + cdSize + (zip64End ? 56 + 20 : 0) + 22;
  return { items, cdOffset, cdSize, zip64End, total };
}

function localHeader(it) {
  const b = Buffer.alloc(30 + it.nameBuf.length + (it.zip64 ? 20 : 0));
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(it.zip64 ? 45 : 20, 4);
  // Bit 11: names are UTF-8. Bit 3: CRC follows the data.
  b.writeUInt16LE(it.dir ? 0x0800 : 0x0808, 6);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(it.time, 10);
  b.writeUInt16LE(it.date, 12);
  b.writeUInt32LE(0, 14);
  // The sizes are known, so they go here too, for readers that stream.
  b.writeUInt32LE(it.zip64 ? MAX32 : it.size, 18);
  b.writeUInt32LE(it.zip64 ? MAX32 : it.size, 22);
  b.writeUInt16LE(it.nameBuf.length, 26);
  b.writeUInt16LE(it.zip64 ? 20 : 0, 28);
  it.nameBuf.copy(b, 30);
  if (it.zip64) {
    const x = 30 + it.nameBuf.length;
    b.writeUInt16LE(0x0001, x);
    b.writeUInt16LE(16, x + 2);
    b.writeBigUInt64LE(BigInt(it.size), x + 4);
    b.writeBigUInt64LE(BigInt(it.size), x + 12);
  }
  return b;
}

function descriptor(it) {
  const b = Buffer.alloc(it.zip64 ? 24 : 16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(it.crc, 4);
  if (it.zip64) {
    b.writeBigUInt64LE(BigInt(it.size), 8);
    b.writeBigUInt64LE(BigInt(it.size), 16);
  } else {
    b.writeUInt32LE(it.size, 8);
    b.writeUInt32LE(it.size, 12);
  }
  return b;
}

function centralHeader(it) {
  const b = Buffer.alloc(46 + it.nameBuf.length + it.centralExtra);
  const bigOffset = it.offset >= MAX32;
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(45, 4);
  b.writeUInt16LE(it.zip64 || bigOffset ? 45 : 20, 6);
  b.writeUInt16LE(it.dir ? 0x0800 : 0x0808, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(it.time, 12);
  b.writeUInt16LE(it.date, 14);
  b.writeUInt32LE(it.crc || 0, 16);
  b.writeUInt32LE(it.zip64 ? MAX32 : it.size, 20);
  b.writeUInt32LE(it.zip64 ? MAX32 : it.size, 24);
  b.writeUInt16LE(it.nameBuf.length, 28);
  b.writeUInt16LE(it.centralExtra, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE(it.dir ? 0x10 : 0, 38);
  b.writeUInt32LE(bigOffset ? MAX32 : it.offset, 42);
  it.nameBuf.copy(b, 46);
  if (it.centralExtra) {
    let x = 46 + it.nameBuf.length;
    b.writeUInt16LE(0x0001, x);
    b.writeUInt16LE(it.centralExtra - 4, x + 2);
    x += 4;
    if (it.zip64) {
      b.writeBigUInt64LE(BigInt(it.size), x);
      b.writeBigUInt64LE(BigInt(it.size), x + 8);
      x += 16;
    }
    if (bigOffset) b.writeBigUInt64LE(BigInt(it.offset), x);
  }
  return b;
}

function endRecords(p) {
  const parts = [];
  const n = p.items.length;
  if (p.zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(n), 24);
    z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(p.cdSize), 40);
    z.writeBigUInt64LE(BigInt(p.cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(p.cdOffset + p.cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(n, 0xffff), 8);
  e.writeUInt16LE(Math.min(n, 0xffff), 10);
  e.writeUInt32LE(Math.min(p.cdSize, MAX32), 12);
  e.writeUInt32LE(Math.min(p.cdOffset, MAX32), 16);
  parts.push(e);
  return Buffer.concat(parts);
}

function write(out, buf) {
  return out.write(buf) ? null : new Promise((r) => out.once('drain', r));
}

async function streamZip(out, p) {
  for (const it of p.items) {
    if (out.destroyed) return;
    await write(out, localHeader(it));
    if (it.dir) continue;
    let crc = 0;
    let sent = 0;
    for await (const chunk of fs.createReadStream(it.file, { highWaterMark: 1 << 20 })) {
      // Never send more than was promised, or the zip and Content-Length break.
      const part = sent + chunk.length > it.size ? chunk.subarray(0, it.size - sent) : chunk;
      crc = zlib.crc32(part, crc);
      sent += part.length;
      if (out.destroyed) return;
      await write(out, part);
      if (sent >= it.size) break;
    }
    if (sent < it.size) throw new Error(`${it.name} is shorter on disk than expected`);
    it.crc = crc;
    await write(out, descriptor(it));
  }
  for (const it of p.items) await write(out, centralHeader(it));
  out.end(endRecords(p));
}

module.exports = { plan, streamZip };
