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

module.exports = { NAME, isPage, skinPage };
