'use strict';

// Viewing formats a browser can't show (HEIC on Windows and Android, MKV, AVI,
// 3GP...). The original is never touched: a browser-friendly copy (a JPEG, or
// an MP4) is made on first use with ffmpeg and heif-convert, kept beside the
// owner's Nest folder, and served from there afterwards.

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE_EXT = ['heic', 'heif', 'hif', 'tif', 'tiff'];
const VIDEO_EXT = ['3gp', '3g2', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'mov', 'm4v', 'ogv', 'vob', 'asf'];

const TYPES = {
  heic: 'image/heic', heif: 'image/heif', hif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2', mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t',
  mov: 'video/quicktime', m4v: 'video/x-m4v', ogv: 'video/ogg', vob: 'video/mpeg', asf: 'video/x-ms-asf',
};

const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

// 'image' or 'video' when the name is a format that may need converting, else ''.
function convertKind(name) {
  const e = extOf(name);
  return IMAGE_EXT.includes(e) ? 'image' : VIDEO_EXT.includes(e) ? 'video' : '';
}

const typeOf = (name) => TYPES[extOf(name)] || '';
const previewName = (id, kind) => `${id}.${kind === 'image' ? 'jpg' : 'mp4'}`;
const previewType = (kind) => (kind === 'image' ? 'image/jpeg' : 'video/mp4');

function run(cmd, args, { timeout = 15 * 60 * 1000, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let out = '';
    if (capture) child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} stopped (${code})`));
    });
  });
}

async function toJpeg(src, out) {
  const tmp = `${out}.part.jpg`;
  try {
    // heif-convert turns the photo the right way up; ffmpeg covers everything else.
    if (['heic', 'heif', 'hif'].includes(extOf(src))) {
      try {
        await run('heif-convert', ['-q', '85', src, tmp]);
      } catch {
        await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '3', tmp]);
      }
    } else {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '3', tmp]);
    }
    // heif-convert names a multi-image file <name>-1.jpg; take the first.
    return tmp;
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

async function codecs(src) {
  const probe = async (sel) => (await run('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src], { capture: true, timeout: 30000 })).trim().split('\n')[0];
  return { v: await probe('v:0').catch(() => ''), a: await probe('a:0').catch(() => '') };
}

async function toMp4(src, out) {
  const tmp = `${out}.part.mp4`;
  try {
    const c = await codecs(src);
    // Already H.264 / AAC: only the box around it changes, which is quick and lossless.
    const v = c.v === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
    const a = c.a === 'aac' || c.a === 'mp3' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', ...v, ...a, '-sn', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    return tmp;
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

// One conversion at a time (a small box), and one per file however many ask.
const pending = new Map();
let chain = Promise.resolve();

// Path of the browser-friendly copy of `src`, making it if needed.
async function previewFile(src, dir, id, kind) {
  const out = path.join(dir, previewName(id, kind));
  try {
    if ((await fsp.stat(out)).size > 0) return out;
  } catch { /* not made yet */ }
  if (!pending.has(out)) {
    const job = chain.then(async () => {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = await (kind === 'image' ? toJpeg : toMp4)(src, out + '.' + crypto.randomBytes(3).toString('hex'));
      await fsp.rename(tmp, out);
      return out;
    });
    chain = job.catch(() => {});
    pending.set(out, job);
    const done = () => pending.delete(out);
    job.then(done, done);
  }
  return pending.get(out);
}

module.exports = { convertKind, typeOf, previewFile, previewName, previewType, extOf };
