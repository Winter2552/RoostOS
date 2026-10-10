// Roostflix: runs inside Jellyfin's page (added by Roost). Everything here is
// best effort; if any of it fails, Jellyfin simply looks like Jellyfin.
(() => {
  'use strict';
  const NAME = 'Roostflix';

  // Jellyfin sets the tab title itself on every page change; keep our name.
  const title = document.querySelector('title');
  const keep = () => {
    const t = title.textContent;
    if (/jellyfin/i.test(t)) title.textContent = t.replace(/jellyfin/gi, NAME);
  };
  if (title) {
    keep();
    new MutationObserver(keep).observe(title, { childList: true, characterData: true, subtree: true });
  }
  document.documentElement.dataset.roostflix = '1';
})();
