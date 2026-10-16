'use strict';

// What's new: a sheet the first time someone opens Roost after an update (one
// slide per item, newest first), and a page that keeps every release.
// Nothing runs on a timer: the releases are fetched only when the sheet or the
// page opens, and the pictures load as slides come up.

(function () {
  let cache = null;

  async function releases() {
    if (!cache) cache = (await api('GET', '/api/releases')).releases;
    return cache;
  }

  function dots() {
    const has = (state.user.whatsNew || []).length > 0;
    $('#wn-dot').classList.toggle('hidden', !has);
    $('#avatar-dot').classList.toggle('hidden', !has);
  }

  // Tells the server this person has seen everything up to now.
  async function markSeen() {
    if (!(state.user.whatsNew || []).length) return;
    state.user.whatsNew = [];
    dots();
    try {
      const res = await api('POST', '/api/me/whats-new/seen');
      state.user = res.user;
    } catch { /* it just shows again next time */ }
  }

  function picture(item, eager) {
    return el('img', { class: 'wn-img', src: `/releases/img/${encodeURIComponent(item.image)}`, alt: item.title, loading: eager ? 'eager' : 'lazy', decoding: 'async' });
  }

  async function showSheet() {
    let slides;
    try {
      const unseen = new Set(state.user.whatsNew);
      slides = (await releases()).filter((r) => unseen.has(r.version)).flatMap((r) => r.items.map((item) => ({ ...item, version: r.version, title2: r.title })));
    } catch { return; }
    if (!slides.length) { markSeen(); return; }
    const opener = document.activeElement;
    let at = 0;
    const track = el('div', { class: 'wn-track' }, slides.map((s, i) => el('article', { class: 'wn-slide', 'aria-hidden': i ? 'true' : 'false' },
      el('div', { class: 'wn-shot' }, picture(s, i < 2)),
      el('div', { class: 'wn-copy' },
        el('span', { class: 'mono muted wn-ver', text: `v${s.version}` }),
        el('h2', { text: s.title }),
        el('p', { text: s.text })))));
    const pager = el('div', { class: 'wn-dots', 'aria-hidden': 'true' }, slides.map(() => el('span')));
    const next = el('button', { class: 'btn', type: 'button' });
    const sheet = el('div', { class: 'wn-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': "What's new" },
      el('div', { class: 'wn-top' },
        el('span', { class: 'mono muted', text: "What's new" }),
        el('button', { class: 'wn-x', type: 'button', 'aria-label': 'Close', text: '×', onclick: close })),
      track,
      el('div', { class: 'wn-foot' }, pager, next));

    function go(i) {
      at = Math.max(0, Math.min(slides.length - 1, i));
      track.style.transform = `translateX(${-100 * at}%)`;
      [...track.children].forEach((n, j) => { n.setAttribute('aria-hidden', j === at ? 'false' : 'true'); n.classList.toggle('on', j === at); });
      [...pager.children].forEach((n, j) => n.classList.toggle('on', j === at));
      pager.classList.toggle('hidden', slides.length < 2);
      next.textContent = at === slides.length - 1 ? 'Done' : 'Next';
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      sheet.remove();
      markSeen();
      if (opener && opener.isConnected) opener.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(at + 1);
      else if (e.key === 'ArrowLeft') go(at - 1);
      else if (e.key === 'Tab') {
        const stops = [...sheet.querySelectorAll('button')];
        if (e.shiftKey && document.activeElement === stops[0]) { e.preventDefault(); stops.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === stops.at(-1)) { e.preventDefault(); stops[0].focus(); }
      }
    }
    next.addEventListener('click', () => (at === slides.length - 1 ? close() : go(at + 1)));
    // Swipe on touch screens.
    let x0 = null;
    track.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    track.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) go(at + (dx < 0 ? 1 : -1));
    }, { passive: true });
    document.addEventListener('keydown', onKey);
    document.body.append(sheet);
    go(0);
    next.focus();
  }

  async function page() {
    const box = $('#wn-list');
    let list;
    try { list = await releases(); } catch { box.replaceChildren(el('p', { class: 'mono muted', text: 'Couldn’t load this just now.' })); return; }
    const fresh = new Set(state.user.whatsNew || []);
    box.replaceChildren(...list.map((r) => el('article', { class: 'card panel wn-release' },
      el('div', { class: 'wn-release-head' },
        el('h3', { text: r.title }),
        el('span', { class: 'mono muted', text: `v${r.version} · ${shortDate(r.date)}${fresh.has(r.version) ? ' · new' : ''}` })),
      r.summary ? el('p', { class: 'wn-summary', text: r.summary }) : null,
      el('div', { class: 'wn-items' }, r.items.map((item) => el('div', { class: 'wn-item' },
        picture(item, false),
        el('div', {}, el('b', { text: item.title }), el('p', { text: item.text }))))))));
    markSeen();
  }

  window.whatsNewMaybe = () => { dots(); if (state.user && (state.user.whatsNew || []).length && !location.hash.startsWith('#/whatsnew')) showSheet(); };
  window.whatsNewPage = page;
})();
