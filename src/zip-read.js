'use strict';

// Reads zip files straight from disk, for Move to Glint (Google Takeout).
//
// Only the list at the end of the zip is read up front, so a 50 GB zip opens
// at once. One entry is then read at a time as a stream, inflated as it goes,
// so nothing is unpacked to disk first. Supports zip64 (zips over 4 GB) and
// stored or deflated entries. Each entry's CRC is checked as it streams, so a
// damaged download shows up as an error on that file instead of a bad photo.

const fs = require('fs');
const zlib = require('zlib');
const { Transform } = require('stream');

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY = 512 * 1024 * 1024; // refuse an absurd central directory

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (!bytesRead) throw new Error('This zip is cut short');
    got += bytesRead;
  }
  return buf;
}

// DOS date and time (local time) to ms.
function dosToMs(date, time) {
  const year = 1980 + (date >> 9);
  const month = ((date >> 5) & 15) - 1;
  const day = date & 31;
  return new Date(year, Math.max(0, month), Math.max(1, day), time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}

// Checks the CRC of the bytes passing through and that there are exactly `size` of them.
function checker(entry) {
  let crc = 0;
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > entry.size) return cb(new Error(`${entry.name} is bigger than the zip says`));
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      if (n !== entry.size) return cb(new Error(`${entry.name} is shorter than the zip says`));
      if (crc !== entry.crc) return cb(new Error(`${entry.name} is damaged (CRC mismatch)`));
      cb();
    },
  });
}

// Opens a zip. Returns { entries, open(entry), close() }.
//   entry: { name, size, csize, crc, method, offset, mtime, dir }
async function openZip(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    if (total < 22) throw new Error('That is not a zip file');
    const tailLen = Math.min(total, 22 + MAX_COMMENT);
    const tail = await readAt(fh, tailLen, total - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That is not a zip file, or it did not finish downloading');

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== EOCD64_LOC_SIG) throw new Error('Damaged zip64 end record');
      const eocd64At = Number(tail.readBigUInt64LE(locAt + 8));
      const rec = await readAt(fh, 56, eocd64At);
      if (rec.readUInt32LE(0) !== EOCD64_SIG) throw new Error('Damaged zip64 end record');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > MAX_DIRECTORY || cdOffset + cdSize > total) throw new Error('Damaged zip directory');

    const cd = await readAt(fh, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new Error('Damaged zip directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // Zip64 extra field: the 32-bit fields that were maxed out, in this order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let y = x + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(y)); y += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(y)); y += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(y)); }
        }
        x += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      entries.push({ name, size, csize, crc, method, offset, mtime: dosToMs(date, time), dir: name.endsWith('/'), encrypted: Boolean(flags & 1) });
    }

    return {
      entries,
      // A readable stream of the entry's bytes, inflated and CRC-checked.
      async open(entry) {
        if (entry.encrypted) throw new Error(`${entry.name} is password protected`);
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses a zip method Roost can't read`);
        const loc = await readAt(fh, 30, entry.offset);
        if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error('Damaged zip entry');
        const start = entry.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
        if (start + entry.csize > total) throw new Error('This zip is cut short');
        const raw = entry.csize === 0 ? require('stream').Readable.from([]) : fs.createReadStream(file, { start, end: start + entry.csize - 1, highWaterMark: 256 * 1024 });
        const out = checker(entry);
        const parts = entry.method === 8 ? [raw, zlib.createInflateRaw(), out] : [raw, out];
        // Pass an error from any stage on to the one the caller reads.
        for (let i = 0; i < parts.length - 1; i++) {
          parts[i].on('error', (err) => out.destroy(err));
          parts[i].pipe(parts[i + 1]);
        }
        out.on('close', () => { raw.destroy(); });
        return out;
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

module.exports = { openZip };
