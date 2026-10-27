'use strict';

// Roostflix: the look Roost gives Jellyfin's web page when it passes it
// through under /jellyfin/. Roost adds one stylesheet and one script (both
// ship in public/roostflix/) and swaps the name and icon. Nothing is
// installed in Jellyfin. If the files fail to load, Jellyfin's own page
// simply shows as before.

const NAME = 'Roostflix';
const CSS = '/roostflix/skin.css';
const JS = '/roostflix/skin.js';
const ICON = '/roostflix/icon.svg';

// Jellyfin's page the browser asks for at the start (not its scripts or images).
function isPage(method, path) {
  return method === 'GET' && /^\/web\/(index\.html)?(\?.*)?$/.test(path);
}

// The page with the skin added. `version` gives a file's hash, so a changed
// skin file is fetched once and then kept by the browser.
function skinPage(html, version) {
  const v = (file) => `${file}?v=${version(file) || 'x'}`;
  const head = [
    `<link rel="icon" type="image/svg+xml" href="${v(ICON)}">`,
    `<link rel="stylesheet" href="${v(CSS)}">`,
    `<script defer src="${v(JS)}"></script>`,
  ].join('');
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${NAME}</title>`)
    .replace(/<link\b[^>]*\brel=["'](?:shortcut icon|icon|apple-touch-icon|mask-icon)["'][^>]*>/gi, '')
    .replace(/<\/head>/i, `${head}</head>`);
}

// "Play for TV": some TVs with built-in AirPlay take the sound of an HEVC film
// but not the picture. With this switched on (a cookie the skin sets), the
// player's request for how to play a film is changed so HEVC isn't offered
// and Jellyfin converts the picture to H.264 instead of passing it through.
const TV_COOKIE = 'roost_h264';

const wantsTv = (req) => new RegExp(`(?:^|;\\s*)${TV_COOKIE}=1(?:;|$)`).test(req.headers.cookie || '');

function isPlaybackInfo(method, path) {
  return method === 'POST' && /^\/Items\/[\w-]+\/PlaybackInfo(\?.*)?$/.test(path);
}

const withoutHevc = (list) => String(list || '').split(',').map((c) => c.trim()).filter((c) => c && !/^(hevc|h265)$/i.test(c)).join(',');

// The player's device profile with HEVC taken out of the video entries.
function plainProfile(profile) {
  const out = JSON.parse(JSON.stringify(profile));
  for (const key of ['DirectPlayProfiles', 'TranscodingProfiles']) {
    if (!Array.isArray(out[key])) continue;
    out[key] = out[key].filter((x) => {
      if (!x || x.Type !== 'Video' || !x.VideoCodec) return true;
      x.VideoCodec = withoutHevc(x.VideoCodec);
      return Boolean(x.VideoCodec);
    });
  }
  return out;
}

// The request body with that change made, or the body as it was if it isn't
// the JSON this expects.
function tvBody(buffer) {
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    if (!body || !body.DeviceProfile) return buffer;
    body.DeviceProfile = plainProfile(body.DeviceProfile);
    return Buffer.from(JSON.stringify(body));
  } catch {
    return buffer;
  }
}

module.exports = { NAME, isPage, skinPage, TV_COOKIE, wantsTv, isPlaybackInfo, plainProfile, tvBody };
