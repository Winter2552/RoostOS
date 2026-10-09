'use strict';

const zlib = require('zlib');

// Small HTTP helpers shared by the Roost API and Nest.

class HttpError extends Error {
  // `code` is an optional machine-readable reason, sent alongside the message.
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

// Bigger answers (folder listings, the status page) are compressed, which
// matters on the slow upload when someone is away from home. A fast brotli
// level keeps the CPU cost per request tiny.
const COMPRESS_FROM = 1024;

// "br", "gzip" or null, from the browser's Accept-Encoding.
function pickEncoding(header) {
  const h = String(header || '');
  if (/\bbr\b/.test(h)) return 'br';
  if (/\bgzip\b/.test(h)) return 'gzip';
  return null;
}

function send(res, status, body, headers = {}) {
  let data = body === undefined ? '' : JSON.stringify(body);
  const out = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers };
  if (data.length >= COMPRESS_FROM) {
    out.Vary = 'Accept-Encoding';
    const enc = pickEncoding(res.req && res.req.headers['accept-encoding']);
    if (enc === 'br') data = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    if (enc === 'gzip') data = zlib.gzipSync(data, { level: 6 });
    if (enc) out['Content-Encoding'] = enc;
  }
  res.writeHead(status, out);
  res.end(data);
}

async function readJson(req, max = 64 * 1024) {
  // Requiring a JSON content type also blocks plain cross-site form posts.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

module.exports = { HttpError, send, readJson, str, pickEncoding };
