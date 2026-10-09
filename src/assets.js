'use strict';

// Roost's own page files (public/), sent as little as possible.
// - index.html points at each file with ?v=<hash>, and a request with the
//   current hash is cached by the browser for a year: after the first visit
//   the dashboard opens without downloading its scripts or styles again.
// - Everything else carries an ETag, so a repeat visit gets a tiny 304.
// - Text files are compressed once (brotli, or gzip for older browsers) and
//   kept in memory; public/ is small and only changes with a new image.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pickEncoding } = require('./http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESS = new Set(['.html', '.css', '.js', '.svg', '.json', '.webmanifest']);
const YEAR = 365 * 24 * 60 * 60;

class Assets {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
  }

  load(rel) {
    if (this.cache.has(rel)) return this.cache.get(rel);
    const file = path.normalize(path.join(this.dir, rel));
    if (!file.startsWith(this.dir + path.sep)) return null;
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return null;
    }
    const ext = path.extname(file);
    if (rel === '/index.html') data = Buffer.from(this.versionLinks(data.toString('utf8')));
    const asset = {
      data,
      type: MIME[ext] || 'application/octet-stream',
      hash: crypto.createHash('sha256').update(data).digest('base64url').slice(0, 12),
      compress: COMPRESS.has(ext) && data.length > 512,
      encoded: {},
    };
    this.cache.set(rel, asset);
    return asset;
  }

  // href="/style.css" → href="/style.css?v=<hash>" for files in public/.
  versionLinks(html) {
    return html.replace(/\b(href|src)="\/([\w.-]+\.\w+)"/g, (whole, attr, name) => {
      const a = this.load(`/${name}`);
      return a ? `${attr}="/${name}?v=${a.hash}"` : whole;
    });
  }

  encoded(asset, enc) {
    if (!enc || !asset.compress) return null;
    if (!asset.encoded[enc]) {
      asset.encoded[enc] = enc === 'br'
        ? zlib.brotliCompressSync(asset.data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
        : zlib.gzipSync(asset.data, { level: 9 });
    }
    return asset.encoded[enc];
  }

  // Sends the file and returns true, or returns false when there is no such file.
  serve(req, res, pathname, version) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const asset = this.load(rel);
    if (!asset) return false;
    const etag = `"${asset.hash}"`;
    const headers = {
      'Content-Type': asset.type,
      ETag: etag,
      // App icons rarely change, so they are kept for a week without asking.
      'Cache-Control': version && version === asset.hash ? `public, max-age=${YEAR}, immutable`
        : rel.startsWith('/icons/') ? 'public, max-age=604800' : 'no-cache',
    };
    if (asset.compress) headers.Vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const enc = pickEncoding(req.headers['accept-encoding']);
    const body = this.encoded(asset, enc) || asset.data;
    if (body !== asset.data) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}

module.exports = { Assets };
