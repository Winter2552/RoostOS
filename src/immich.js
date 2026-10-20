'use strict';

// Lets the free Immich phone app back up to Roost. Only the part of Immich's
// server API that app needs to sign in and send photos is answered here; the
// photos go through the same PhotoBackup path as the Android app and the
// iPhone Shortcut, into Glint's Photos/<year> folder. Nothing from Immich runs
// or is installed. In the app, "Server endpoint URL" is the Roost address, the
// email is "<username>@roost" (only the part before the @ is used) and the
// password is a backup key from Profile (or the Roost password when the
// account has no two-step sign-in).
//
// The phone app is made by someone else, so it can ask for things not answered
// here. Those get a plain 404 and a line in the server log naming the request,
// which is how a missing piece is found.

const crypto = require('crypto');
const { HttpError, send, readJson, str } = require('./http');
const { takenMs } = require('./photo-backup');

const ROOTS = ['/api/server', '/api/users', '/api/assets', '/api/sync', '/api/albums'];
const AUTH = ['/api/auth/login', '/api/auth/validateToken', '/api/auth/logout']; // Roost has its own /api/auth/check
const MAX_FIELD = 64 * 1024;

// The version the app is told the server is. Immich's app warns when it
// disagrees too much with the one it was built for, so it can be changed.
const DEFAULT_VERSION = '2.7.5';
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || DEFAULT_VERSION));
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// A stable UUID made from any text: the app wants UUIDs for users and photos.
function uuid(text) {
  const h = crypto.createHash('sha1').update(String(text)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// What the app calls a photo's id before it has a server one.
const photoKey = (deviceAssetId) => `immich|${deviceAssetId}`;

// Reads one multipart upload from the request without keeping the photo in
// memory. Immich's app sends its text fields first and the file last, so the
// file's size is the request length minus everything around it. Calls
// `onFile(fields, file)` once the file part starts; file is
// { name, type, size, source }. Resolves to whatever onFile returned.
async function readUpload(req, onFile) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(req.headers['content-type'] || ''));
  if (!m || !/multipart\/form-data/i.test(req.headers['content-type'])) throw new HttpError(400, 'Send the photo as multipart form data');
  const total = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(total) || total <= 0) throw new HttpError(411, 'Send the upload size (Content-Length)');
  const dash = Buffer.from(`--${m[1] || m[2]}`);
  const tail = Buffer.from(`\r\n${dash}`);
  const it = req[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let eof = false;
  let used = 0; // bytes taken off the front of the body so far
  const more = async () => {
    if (eof) return false;
    const next = await it.next();
    if (next.done) {
      eof = true;
      return false;
    }
    buf = buf.length ? Buffer.concat([buf, next.value]) : next.value;
    return true;
  };
  const drop = (n) => {
    buf = buf.subarray(n);
    used += n;
  };
  const until = async (needle, limit) => {
    for (let from = 0; ;) {
      const at = buf.indexOf(needle, from);
      if (at >= 0) return at;
      if (buf.length > limit) throw new HttpError(400, 'That upload is not shaped right');
      from = Math.max(0, buf.length - needle.length + 1);
      if (!(await more())) throw new HttpError(400, 'The upload ended early');
    }
  };

  const fields = {};
  for (;;) {
    const at = await until(dash, MAX_FIELD);
    drop(at + dash.length);
    while (buf.length < 2 && (await more()));
    if (buf.subarray(0, 2).toString() === '--') throw new HttpError(400, 'The upload has no file in it');
    const headEnd = await until(Buffer.from('\r\n\r\n'), MAX_FIELD);
    const head = buf.subarray(0, headEnd).toString('utf8');
    drop(headEnd + 4);
    const name = /\bname="([^"]*)"/i.exec(head);
    const file = /\bfilename="([^"]*)"/i.exec(head);
    if (!file && !(name && name[1] === 'assetData')) {
      const end = await until(tail, MAX_FIELD);
      if (name) fields[name[1]] = buf.subarray(0, end).toString('utf8');
      drop(end);
      continue;
    }
    // The file part. Everything after it is "\r\n--boundary--\r\n".
    const size = total - used - (tail.length + 4);
    if (!(size >= 0)) throw new HttpError(400, 'That upload is not shaped right');
    const type = (/^content-type:\s*([^\r\n;]+)/im.exec(head) || [])[1] || '';
    let left = size;
    const source = (async function* () {
      while (left > 0) {
        if (!buf.length && !(await more())) throw new HttpError(400, 'The upload ended early');
        const take = Math.min(buf.length, left);
        const piece = buf.subarray(0, take);
        drop(take);
        left -= take;
        yield piece;
      }
    }());
    const out = await onFile(fields, { name: file ? file[1] : '', type: type.trim(), size, source });
    // Whatever was not read (when the photo was refused as already sent) just goes unread.
    if (left > 0) req.resume();
    else while (await more());
    return out;
  }
}

class ImmichApi {
  // signIn(req, name, secret) -> { user, token }; userFor(req) -> user (both throw HttpError).
  constructor({ photoBackup, signIn, userFor, toUser, version, log = () => {} }) {
    this.photoBackup = photoBackup;
    this.signIn = signIn;
    this.userFor = userFor;
    this.toUser = toUser;
    this.version = parseVersion(version);
    this.log = log;
  }

  matches(pathname) {
    return AUTH.includes(pathname) || ROOTS.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  }

  features() {
    const off = ['configFile', 'duplicateDetection', 'email', 'facialRecognition', 'importFaces', 'map', 'oauth', 'oauthAutoLaunch', 'ocr', 'realtimeTranscoding', 'reverseGeocoding', 'search', 'sidecar', 'smartSearch'];
    return { ...Object.fromEntries(off.map((k) => [k, false])), passwordLogin: true, trash: true };
  }

  config() {
    return {
      externalDomain: '', isInitialized: true, isOnboarded: true, loginPageMessage: '', maintenanceMode: false,
      mapDarkStyleUrl: '', mapLightStyleUrl: '', minFaces: 3, oauthButtonText: '', publicUsers: false, trashDays: 30, userDeleteDelay: 7,
      oauthAccountManagementUrl: '',
    };
  }

  userView(user) {
    const created = user.createdAt || new Date(0).toISOString();
    return {
      id: uuid(user.id), email: `${user.username}@roost`, name: user.displayName || user.username,
      avatarColor: 'primary', clusterGroupId: uuid('roost'), createdAt: created, updatedAt: created, profileChangedAt: created,
      deletedAt: null, isAdmin: user.role === 'admin', license: null, oauthId: '', profileImagePath: '',
      quotaSizeInBytes: null, quotaUsageInBytes: 0, shouldChangePassword: false, status: 'active', storageLabel: null,
    };
  }

  async upload(req, res, user) {
    const out = await readUpload(req, async (fields, file) => {
      const key = photoKey(fields.deviceAssetId || `${fields.deviceId || ''}|${file.name}|${file.size}`);
      const id = uuid(key);
      if (this.photoBackup.has(user, key)) return { code: 200, body: { id, status: 'duplicate' } };
      const taken = takenMs(fields.fileCreatedAt);
      let path = this.photoBackup.folderFor(taken);
      // The video half of a Live Photo is sent hidden; keep it beside the photo but out of the way.
      if (/hidden/i.test(fields.visibility || '')) path += '/Live Photo videos';
      await this.photoBackup.storeStream(user, {
        id: key, size: file.size, device: fields.deviceId, name: file.name || 'photo', type: file.type, path,
      }, file.source);
      return { code: 201, body: { id, status: 'created' } };
    });
    send(res, out.code, out.body);
  }

  async handle(req, res, pathname, params) {
    const m = req.method;
    // Open to anyone who can reach the address, like Immich's own: the app checks them before signing in.
    if (m === 'GET' && pathname === '/api/server/ping') return send(res, 200, { res: 'pong' });
    if (m === 'GET' && pathname === '/api/server/version') return send(res, 200, { ...this.version, prerelease: 0, featureLevel: 0 });
    if (m === 'GET' && pathname === '/api/server/features') return send(res, 200, this.features());
    if (m === 'GET' && pathname === '/api/server/config') return send(res, 200, this.config());
    if (m === 'GET' && pathname === '/api/server/media-types') return send(res, 200, { image: ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.webp', '.dng'], video: ['.mov', '.mp4', '.m4v'], sidecar: [] });
    if (m === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(req, 16 * 1024);
      const { user, token } = this.signIn(req, body.email, body.password);
      return send(res, 201, {
        accessToken: token, userId: uuid(user.id), userEmail: `${user.username}@roost`, name: user.displayName || user.username,
        isAdmin: user.role === 'admin', isOnboarded: true, profileImagePath: '', shouldChangePassword: false,
      });
    }
    const user = this.userFor(req);
    if (m === 'POST' && pathname === '/api/auth/validateToken') return send(res, 200, { authStatus: true });
    if (m === 'POST' && pathname === '/api/auth/logout') return send(res, 200, { successful: true, redirectUri: '/auth/login?autoLaunch=0' });
    if (m === 'GET' && pathname === '/api/users/me') return send(res, 200, this.userView(user));
    if (m === 'GET' && pathname === '/api/users/me/preferences') return send(res, 200, {});
    if (m === 'POST' && pathname === '/api/assets') return this.upload(req, res, user);
    if (m === 'POST' && pathname === '/api/assets/bulk-upload-check') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const results = (Array.isArray(body.assets) ? body.assets : []).map((a) => {
        const have = this.photoBackup.has(user, photoKey(a && a.id));
        return have ? { id: a.id, action: 'reject', reason: 'duplicate', assetId: uuid(photoKey(a.id)) } : { id: a && a.id, action: 'accept' };
      });
      return send(res, 200, { results });
    }
    if (m === 'POST' && pathname === '/api/assets/exist') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const ids = (Array.isArray(body.deviceAssetIds) ? body.deviceAssetIds : []).filter((id) => this.photoBackup.has(user, photoKey(id)));
      return send(res, 200, { existingIds: ids });
    }
    // The app lists what the server holds to work out what is new; Roost keeps its own record, so it holds nothing back.
    if (m === 'POST' && pathname === '/api/sync/stream') {
      res.writeHead(200, { 'Content-Type': 'application/jsonlines+json', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (pathname === '/api/sync/ack') return send(res, m === 'GET' ? 200 : 204, m === 'GET' ? [] : undefined);
    if (m === 'GET' && pathname === '/api/albums') return send(res, 200, []);
    this.log(`${m} ${pathname}${params.toString() ? '?…' : ''}`);
    throw new HttpError(404, 'Not found');
  }
}

module.exports = { ImmichApi, readUpload, uuid, parseVersion };
