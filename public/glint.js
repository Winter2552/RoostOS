'use strict';

// Glint: photos and videos. Plain JS, no build step. Loaded after app.js and
// uses its helpers ($, el, api, bytes).
//
// The server does no image work: this page reads each photo's date, draws the
// small preview and sends both back (see src/glint.js), so the first time a
// photo scrolls into view it costs the phone or PC a moment and the server
// nothing.
//
// Mouse: click opens, the tick selects, Shift-click picks a range.
// Touch: tap opens, long-press starts selecting.

(function glint() {
  const GI = {
    photo: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 2.5-2.5L20 17"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z"/>',
    starFill: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z" fill="currentColor"/>',
    album: '<rect x="3.5" y="6" width="14" height="14" rx="2"/><path d="M7 3.5h13.5V17"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    minus: '<path d="M5 12h14"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  };

  function gi(name, cls = '') {
    const s = el('span', { class: `ni ${cls}`, 'aria-hidden': 'true' });
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${GI[name]}</svg>`;
    return s;
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const coarse = matchMedia('(pointer: coarse)');
  // Which photos: '' is your own, 'family' the shared Family space. Every Glint
  // address carries it, so previews, uploads and undo stay in the right place.
  const sp = (url, space = G.space) => (space ? `${url}${url.includes('?') ? '&' : '?'}space=${space}` : url);
  const gapi = (method, url, body, space) => api(method, sp(url, space), body);
  const base = (space = G.space) => (space ? '#/glint/family' : '#/glint');
  const thumbUrl = (p) => sp(`/api/glint/thumbs/${p.id}`);
  const mediaUrl = (p, preview) => sp(`/api/glint/media/${p.id}${preview ? '?preview=1' : ''}`);

  function monthName(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function dayName(ms) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function clock(sec) {
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- state ----------

  const G = {
    space: '',
    hideNest: false, // show only photos added through Glint, not ones that live elsewhere in Nest
    mode: 'photos', // photos | favourites | undated | albums | album | trash | move
    album: null, // { id, name } when mode is 'album'
    items: [],
    next: null,
    total: 0,
    sel: new Set(),
    anchor: null,
    token: 0,
    loading: false,
    albums: [],
    storage: null,
  };

  try { G.hideNest = localStorage.getItem('glint.hideNest') === '1'; } catch { /* private mode */ }
  // Show only photos added through Glint, not ones that live elsewhere in Nest (e.g. moved in from Google Drive).
  const hideNest = $('#glint-hide-nest');
  hideNest.checked = G.hideNest;
  hideNest.addEventListener('change', () => {
    G.hideNest = hideNest.checked;
    try { localStorage.setItem('glint.hideNest', G.hideNest ? '1' : '0'); } catch { /* private mode */ }
    if (G.mode !== 'photos' && G.mode !== 'favourites') return;
    G.items = []; G.next = null; G.total = 0; G.sel.clear();
    render();
    load(true);
  });
  const body = $('#glint-body');
  const view = $('#view-glint');
  const byId = (id) => G.items.find((i) => i.id === id);
  const selected = () => G.items.filter((i) => G.sel.has(i.id));

  // ---------- loading ----------

  window.glintOpen = (parts) => {
    closeViewer();
    const space = parts[0] === 'family' ? 'family' : '';
    if (space) parts = parts.slice(1);
    if (space && !state.user.family) {
      location.hash = '#/glint';
      return;
    }
    const [a, b] = parts;
    if (space !== G.space) G.storage = null;
    G.space = space;
    const mode = a === 'favourites' ? 'favourites' : a === 'undated' ? 'undated' : a === 'albums' ? 'albums' : a === 'album' && b ? 'album' : a === 'trash' ? 'trash' : a === 'move' ? 'move' : 'photos';
    G.mode = mode;
    G.album = mode === 'album' ? { id: b, name: '' } : null;
    G.items = [];
    G.next = null;
    G.total = 0;
    G.sel.clear();
    G.anchor = null;
    thumbQueue.length = 0;
    render();
    load(true);
  };

  async function load(first) {
    if (G.loading && !first) return;
    const token = ++G.token;
    G.loading = true;
    try {
      if (G.mode === 'albums') {
        const { albums } = await gapi('GET', '/api/glint/albums');
        if (token !== G.token) return;
        G.albums = albums;
      } else if (G.mode === 'move') {
        await move.fetchStatus();
      } else if (G.mode === 'trash') {
        const d = await gapi('GET', '/api/glint/trash');
        if (token !== G.token) return;
        G.items = d.items;
        G.storage = d.storage;
      } else {
        const q = new URLSearchParams();
        if (!first && G.next) q.set('before', G.next);
        if (G.mode === 'favourites') q.set('fav', '1');
        if (G.mode === 'undated') q.set('undated', '1');
        if (G.hideNest && (G.mode === 'photos' || G.mode === 'favourites')) q.set('own', '1');
        if (G.mode === 'album') q.set('album', G.album.id);
        const d = await gapi('GET', `/api/glint/photos?${q}`);
        if (token !== G.token) return;
        G.items = first ? d.items : G.items.concat(d.items);
        G.next = d.next;
        if (first) { G.total = d.total; G.storage = d.storage; }
        if (G.mode === 'album' && !G.album.name) {
          const { albums } = await gapi('GET', '/api/glint/albums');
          G.albums = albums;
          G.album.name = (albums.find((x) => x.id === G.album.id) || {}).name || 'Album';
        }
      }
      G.error = '';
    } catch (err) {
      if (token !== G.token) return;
      G.error = err.status === 404 && G.mode === 'album' ? 'That album no longer exists.' : err.message;
    } finally {
      if (token === G.token) G.loading = false;
    }
    render();
    watchEnd();
    pollMove();
  }

  // Loads the next page when the end of the list nears the screen.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && G.next && !G.loading) load(false);
  }, { rootMargin: '800px' });
  observer.observe($('#glint-sentinel'));
  function watchEnd() {
    // After a page lands, check again in case the sentinel is still on screen.
    const s = $('#glint-sentinel').getBoundingClientRect();
    if (G.next && !G.loading && s.top < innerHeight + 800) load(false);
  }

  // ---------- rendering ----------

  // Admin → Family changed whether this person is in the family.
  window.glintFamily = () => {
    if (!view.classList.contains('hidden') && G.space && !state.user.family) location.hash = '#/glint';
    else render();
  };

  function render() {
    document.querySelectorAll('#view-glint [data-place]').forEach((a) => {
      const place = G.mode === 'album' ? 'albums' : G.mode;
      a.classList.toggle('active', a.dataset.place === place);
      a.href = `${base()}${a.dataset.place === 'photos' ? '' : `/${a.dataset.place}`}`;
    });
    document.querySelectorAll('#view-glint [data-space]').forEach((a) => {
      a.classList.toggle('active', a.dataset.space === G.space);
    });
    $('#glint-spaces').classList.toggle('hidden', !state.user.family);
    renderStorage();
    renderCrumbs();
    renderTools();
    renderSel();
    if (G.error) {
      body.replaceChildren(el('div', { class: 'nest-empty' }, el('b', { text: 'Couldn’t load' }), el('span', { class: 'muted', text: G.error })));
      return;
    }
    if (G.mode === 'albums') return renderAlbums();
    if (G.mode === 'trash') return renderTrash();
    if (G.mode === 'move') return renderMove();
    renderTimeline();
  }

  function renderStorage() {
    const s = G.storage;
    if (!s) return;
    const pctUsed = s.limitBytes ? Math.min(100, (s.usedBytes / s.limitBytes) * 100) : 0;
    const bar = $('#glint-meter');
    bar.style.width = `${s.limitBytes ? Math.max(pctUsed, 1) : 0}%`;
    bar.parentNode.classList.toggle('high', pctUsed >= 90);
    bar.parentNode.classList.toggle('hidden', !s.limitBytes);
    $('#glint-used').textContent = s.limitBytes ? `${bytes(s.usedBytes)} of ${bytes(s.limitBytes)} used` : `${bytes(s.usedBytes)} used`;
    // Nearly full: say so, with the way to get more space right there.
    const more = $('#glint-more');
    more.classList.toggle('hidden', pctUsed < 90);
    if (pctUsed >= 90) { const m = moreSpace(); more.href = m.href; more.textContent = m.text; }
  }

  function renderCrumbs() {
    const names = { photos: 'Photos', favourites: 'Favourites', undated: 'Undated', albums: 'Albums', trash: 'Trash', move: 'Move to Glint' };
    const crumbs = $('#glint-crumbs');
    if (G.mode === 'album') {
      crumbs.replaceChildren(
        el('a', { class: 'crumb', href: `${base()}/albums`, text: 'Albums' }),
        gi('right', 'crumb-sep'),
        el('h2', { text: G.album.name || '…' }));
      document.title = `${G.album.name || 'Album'} · ${state.serverName}`;
    } else {
      const title = G.space ? `Family ${names[G.mode].toLowerCase()}` : names[G.mode];
      crumbs.replaceChildren(el('h2', { text: title }));
      document.title = `${title} · ${state.serverName}`;
    }
  }

  function renderTools() {
    const tools = $('#glint-tools');
    const note = (text) => el('span', { class: 'mono muted glint-count', text });
    if (G.mode === 'photos') tools.replaceChildren(note(G.total ? plural(G.total, 'item') : ''));
    else if (G.mode === 'undated') {
      tools.replaceChildren(note(G.total ? plural(G.total, 'photo') : ''),
        G.items.length ? el('button', { type: 'button', class: 'btn ghost small', text: 'Use file names', onclick: () => dateFromNames(G.items) }) : '');
    }
    else if (G.mode === 'favourites' || G.mode === 'move') tools.replaceChildren();
    else if (G.mode === 'albums') tools.replaceChildren(el('button', { type: 'button', class: 'btn ghost small', text: 'New album', onclick: () => newAlbum([]) }));
    else if (G.mode === 'album') {
      tools.replaceChildren(
        el('button', { type: 'button', class: 'btn ghost small', text: 'Rename', onclick: renameAlbum }),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Delete album', onclick: deleteAlbum }));
    } else if (G.mode === 'trash') {
      tools.replaceChildren(G.items.length ? el('button', { type: 'button', class: 'btn ghost small', text: 'Empty trash', onclick: emptyTrash }) : '');
    }
  }

  function renderTimeline() {
    if (G.loading && !G.items.length) {
      body.replaceChildren(el('div', { class: 'muted glint-note', text: 'Loading…' }));
      return;
    }
    if (!G.items.length) {
      const [head, text] = {
        photos: ['No photos yet', coarse.matches ? 'Tap Upload to add photos and videos.' : 'Drop photos here, or press Upload.'],
        favourites: ['No favourites yet', 'Tap the star on a photo to keep it here.'],
        undated: ['Every photo has a date', 'Photos with no date taken inside them show up here, so you can date them.'],
        album: ['This album is empty', 'Select photos in Photos and choose Add to album.'],
      }[G.mode];
      body.replaceChildren(el('div', { class: 'nest-empty' }, gi('photo'), el('b', { text: head }), el('span', { class: 'muted', text: text })));
      return;
    }
    // One grid per month, with the month as a heading, so scrolling stays oriented.
    const parts = [];
    let grid = null;
    let month = '';
    for (const p of G.items) {
      const m = monthName(p.taken);
      if (m !== month) {
        month = m;
        parts.push(el('h3', { class: 'glint-month mono muted', text: m }));
        grid = el('div', { class: 'glint-grid' });
        parts.push(grid);
      }
      grid.append(tile(p));
    }
    body.replaceChildren(...parts);
    for (const t of body.querySelectorAll('.gtile[data-need]')) tileObserver.observe(t);
  }

  function tile(p) {
    const t = el('div', {
      class: `gtile${G.sel.has(p.id) ? ' sel' : ''}${G.sel.size ? ' selecting' : ''}`,
      'data-id': p.id,
      role: 'button',
      tabindex: '0',
      'aria-label': `${p.video ? 'Video' : 'Photo'} ${p.name}, ${dayName(p.taken)}`,
    });
    if (p.thumb === 1) t.append(el('img', { src: thumbUrl(p), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
    else if (p.thumb === 2) t.append(el('span', { class: 'gtile-blank' }, gi(p.video ? 'play' : 'photo')));
    else { t.dataset.need = '1'; t.append(el('span', { class: 'gtile-blank' }, gi(p.video ? 'play' : 'photo'))); }
    if (p.live) t.append(el('span', { class: 'gtile-live mono', text: 'LIVE' }));
    if (p.video) t.append(el('span', { class: 'gtile-video mono' }, gi('play'), p.dur ? clock(p.dur) : ''));
    if (p.fav) t.append(el('span', { class: 'gtile-fav' }, gi('starFill')));
    t.append(el('button', { type: 'button', class: 'gtile-tick', 'aria-label': G.sel.has(p.id) ? 'Deselect' : 'Select', 'data-tick': '1' }, gi('check')));
    return t;
  }

  // ---------- selecting and opening ----------

  body.addEventListener('click', (e) => {
    const t = e.target.closest('.gtile');
    if (!t) return;
    const p = byId(t.dataset.id);
    if (!p) return;
    if (e.target.closest('[data-tick]') || G.sel.size || e.ctrlKey || e.metaKey) {
      if (e.shiftKey && G.anchor) selectRange(G.anchor, p.id);
      else toggle(p.id);
      return;
    }
    openViewer(G.items.indexOf(p));
  });

  body.addEventListener('keydown', (e) => {
    const t = e.target.closest('.gtile');
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); openViewer(G.items.indexOf(byId(t.dataset.id))); }
    if (e.key === ' ') { e.preventDefault(); toggle(t.dataset.id); }
  });

  // Long-press selects on touch screens.
  let press = null;
  body.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.gtile');
    if (!t || e.pointerType === 'mouse') return;
    press = { id: t.dataset.id, x: e.clientX, y: e.clientY, fired: false };
    press.timer = setTimeout(() => { press.fired = true; navigator.vibrate?.(10); toggle(press.id); }, 450);
  });
  const endPress = () => { if (press) clearTimeout(press.timer); };
  body.addEventListener('pointerup', endPress);
  body.addEventListener('pointercancel', endPress);
  body.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) endPress();
  });
  body.addEventListener('contextmenu', (e) => { if (e.target.closest('.gtile') && coarse.matches) e.preventDefault(); });
  // The tap that ends a long-press should not also open the photo.
  body.addEventListener('click', (e) => { if (press && press.fired) { e.stopImmediatePropagation(); press = null; } }, true);

  function toggle(id) {
    if (G.sel.has(id)) G.sel.delete(id); else G.sel.add(id);
    G.anchor = id;
    paintSelection();
  }

  function selectRange(a, b) {
    const i = G.items.findIndex((x) => x.id === a);
    const j = G.items.findIndex((x) => x.id === b);
    if (i < 0 || j < 0) return;
    for (const x of G.items.slice(Math.min(i, j), Math.max(i, j) + 1)) G.sel.add(x.id);
    paintSelection();
  }

  function clearSel() {
    G.sel.clear();
    paintSelection();
  }

  function paintSelection() {
    if (G.mode === 'trash') { renderSel(); renderTrash(); return; }
    body.querySelectorAll('.gtile').forEach((t) => {
      t.classList.toggle('sel', G.sel.has(t.dataset.id));
      t.classList.toggle('selecting', G.sel.size > 0);
    });
    renderSel();
  }

  function renderSel() {
    const bar = $('#glint-selbar');
    const items = selected();
    bar.classList.toggle('hidden', !items.length);
    $('#glint-tools').classList.toggle('hidden', items.length > 0);
    if (!items.length) return;
    const btn = (name, text, run) => el('button', { type: 'button', class: 'nsel-btn', onclick: run, title: text }, gi(name), el('span', { text }));
    const allFav = items.every((i) => i.fav);
    const actions = G.mode === 'trash'
      ? [btn('restore', 'Restore', () => restore(items)), btn('trash', 'Delete forever', () => deleteForever(items))]
      : [
        btn(allFav ? 'star' : 'starFill', allFav ? 'Unfavourite' : 'Favourite', () => favourite(items, !allFav)),
        btn('calendar', 'Set date', () => setDate(items)),
        btn('album', 'Add to album', () => albumPicker(items)),
        btn('download', 'Download', () => download(items)),
        G.mode === 'album' ? btn('minus', 'Remove from album', () => removeFromAlbum(items)) : null,
        btn('trash', 'Delete', () => trash(items)),
      ].filter(Boolean);
    bar.replaceChildren(
      el('button', { type: 'button', class: 'nsel-btn', onclick: clearSel, 'aria-label': 'Clear selection' }, gi('close')),
      el('span', { class: 'nsel-count', text: `${items.length} selected` }),
      el('span', { class: 'nsel-actions' }, ...actions));
  }

  // ---------- dialogs and toast (same look as Nest's) ----------

  const dialog = el('dialog', { class: 'card ndialog' });
  document.body.append(dialog);

  function showDialog(title, content, buttons) {
    dialog.replaceChildren(el('h3', { text: title }), ...content, el('div', { class: 'ndialog-buttons' }, ...buttons));
    dialog.onclose = null;
    // Swapping one dialog for the next keeps the same window open.
    if (!dialog.open) dialog.showModal();
  }

  function ask({ title, value = '', ok = 'OK' }) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', value, maxlength: 80, 'aria-label': title, autocapitalize: 'sentences', spellcheck: 'false' });
      const form = el('form', { method: 'dialog' }, input);
      const done = (v) => { dialog.onclose = null; dialog.close(); resolve(v); };
      form.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); });
      showDialog(title, [form], [
        el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => done(null) }),
        el('button', { type: 'button', class: 'btn small', text: ok, onclick: () => form.requestSubmit() }),
      ]);
      dialog.onclose = () => resolve(null);
      input.focus();
      input.select();
    });
  }

  function confirmBox({ title, text, ok, danger }) {
    return new Promise((resolve) => {
      const done = (v) => { dialog.onclose = null; dialog.close(); resolve(v); };
      showDialog(title, [el('p', { class: 'muted', text })], [
        el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => done(false) }),
        el('button', { type: 'button', class: `btn small${danger ? ' danger-fill' : ''}`, text: ok, onclick: () => done(true) }),
      ]);
      dialog.onclose = () => resolve(false);
      dialog.querySelector('.ndialog-buttons .btn:last-child').focus();
    });
  }

  const toastBox = el('div', { class: 'ntoast hidden', role: 'status' });
  document.body.append(toastBox);
  let toastTimer = null;
  function toast(text, undo) {
    clearTimeout(toastTimer);
    toastBox.replaceChildren(...[el('span', { text }), undo
      ? el('button', { type: 'button', class: 'link-btn mono', text: 'Undo', onclick: async () => { toastBox.classList.add('hidden'); try { await undo(); } catch (err) { toast(err.message); } } })
      : null].filter(Boolean));
    toastBox.classList.remove('hidden');
    toastTimer = setTimeout(() => toastBox.classList.add('hidden'), undo ? 7000 : 4000);
  }

  // ---------- actions ----------

  function removeLocal(ids) {
    const gone = new Set(ids);
    const before = G.items.length;
    G.items = G.items.filter((i) => !gone.has(i.id));
    G.total = Math.max(0, G.total - (before - G.items.length)); // a Live Photo's clip isn't a tile of its own
    for (const id of gone) G.sel.delete(id);
    render();
    watchEnd();
  }

  async function favourite(items, on) {
    try {
      await gapi('POST', '/api/glint/favourite', { ids: items.map((i) => i.id), on });
      for (const i of items) i.fav = on;
      if (G.mode === 'favourites' && !on) removeLocal(items.map((i) => i.id));
      else { render(); }
    } catch (err) { toast(err.message); }
  }

  // ---------- dates ----------

  const dayInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // A date in a file name: IMG_20060801_101112, 2021-03-02 10.11.12, WhatsApp Image 2023-05-04 at 21.02.40,
  // Screenshot_2021-03-02-10-11-12, PXL_20210302_101112345. Local time of this device; noon when there is no time.
  function dateFromName(name) {
    const m = /(?<!\d)((?:19|20)\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)(?:[\s_.T-]+(?:at\s+)?([01]\d|2[0-3])[-_.: ]?([0-5]\d)[-_.: ]?([0-5]\d)(?!\d))?/i.exec(name);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 12, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
    // 31 February and the like: not a date.
    return d.getMonth() === Number(m[2]) - 1 && d.getFullYear() <= new Date().getFullYear() + 1 ? d.getTime() : null;
  }

  // Send new dates, then show them: photos that are no longer undated leave the Undated page, and the
  // timeline is put back in order. Undo puts every photo's old date back.
  async function applyDates(items, body, text) {
    const before = items.map((i) => ({ id: i.id, taken: i.taken, src: i.set ? 1 : 0, exif: i.exif ? 1 : 0 }));
    try {
      const { items: fresh } = await gapi('POST', '/api/glint/date', body);
      const byFresh = new Map(fresh.map((f) => [f.id, f]));
      for (const i of G.items) if (byFresh.has(i.id)) Object.assign(i, byFresh.get(i.id));
      if (G.mode === 'undated') {
        removeLocal(fresh.filter((f) => !f.undated).map((f) => f.id));
        if (V.open) { if (!G.items.length) closeViewer(); else { V.i = Math.min(V.i, G.items.length - 1); showPhoto(); } }
      }
      else { G.sel.clear(); refresh(); }
      toast(text(fresh.length), async () => {
        const { items: back } = await gapi('POST', '/api/glint/date', { restore: before.filter((b) => byFresh.has(b.id)) });
        for (const b of back) { const i = byId(b.id); if (i) Object.assign(i, b); }
        refresh();
      });
    } catch (err) { toast(err.message); }
  }

  function dateFromNames(items) {
    const found = [];
    for (const i of items) {
      const taken = dateFromName(i.name);
      if (taken !== null) found.push({ id: i.id, taken });
    }
    if (!found.length) { toast('None of these file names has a date in it'); return; }
    const mine = items.filter((i) => found.some((f) => f.id === i.id));
    applyDates(mine, { items: found }, (n) => `Dated ${plural(n, 'photo')} from their file names`);
  }

  // Choose a date for the selected photos, or move their dates earlier or later (a camera with the wrong clock).
  function setDate(items) {
    if (!items.length) return;
    const first = items[0];
    const date = el('input', { type: 'date', value: dayInput(first.taken), max: dayInput(Date.now() + 864e5), 'aria-label': 'Date' });
    const days = el('input', { type: 'number', min: '0', max: '36500', value: '1', inputmode: 'numeric', 'aria-label': 'Days' });
    const dir = el('select', { 'aria-label': 'Earlier or later' }, el('option', { value: '-1', text: 'earlier' }), el('option', { value: '1', text: 'later' }));
    const mode = el('select', { 'aria-label': 'How' }, el('option', { value: 'set', text: 'Set to a date' }), el('option', { value: 'shift', text: 'Move by some days' }));
    const setRow = el('label', { class: 'field' }, el('span', { text: 'Date' }), date);
    const shiftRow = el('div', { class: 'field hidden' }, el('span', { text: 'Move every date' }), el('div', { class: 'gdate-shift' }, days, el('span', { text: 'days' }), dir));
    mode.addEventListener('change', () => {
      setRow.classList.toggle('hidden', mode.value !== 'set');
      shiftRow.classList.toggle('hidden', mode.value !== 'shift');
    });
    const done = (v) => { dialog.onclose = null; dialog.close(); if (v) go(); };
    const go = () => {
      if (mode.value === 'set') {
        if (!date.value) return;
        const [y, m, d] = date.value.split('-').map(Number);
        applyDates(items, { ids: items.map((i) => i.id), taken: new Date(y, m - 1, d, 12).getTime() }, (n) => `Dated ${plural(n, 'photo')} ${dayName(new Date(y, m - 1, d).getTime())}`);
      } else {
        const n = Math.round(Number(days.value));
        if (!Number.isFinite(n) || n < 0) return;
        const shift = Number(dir.value) * n * 864e5;
        applyDates(items, { ids: items.map((i) => i.id), shift }, (c) => `Moved ${plural(c, 'date')} ${n} ${n === 1 ? 'day' : 'days'} ${shift < 0 ? 'earlier' : 'later'}`);
      }
    };
    showDialog(items.length === 1 ? 'Set date' : `Set date for ${items.length} photos`, [
      el('label', { class: 'field' }, el('span', { text: 'What to do' }), mode),
      setRow,
      shiftRow,
      el('p', { class: 'muted', text: 'Only Glint’s date changes. The photo files are never touched.' }),
    ], [
      el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => done(false) }),
      el('button', { type: 'button', class: 'btn small', text: 'Save', onclick: () => done(true) }),
    ]);
    dialog.onclose = () => {};
    date.focus();
  }

  function download(items) {
    const one = items.length === 1;
    const a = el('a', { href: sp(one ? `/api/glint/download/${items[0].id}` : `/api/glint/zip?ids=${items.map((i) => i.id).join(',')}`), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function trash(items) {
    try {
      const { trashed } = await gapi('POST', '/api/glint/trash', { ids: items.map((i) => i.id) });
      removeLocal(trashed);
      toast(`${plural(trashed.length, 'item')} moved to trash`, async () => {
        await gapi('POST', '/api/glint/restore', { ids: trashed });
        load(true);
      });
    } catch (err) { toast(err.message); }
  }

  async function restore(items) {
    try {
      const { restored } = await gapi('POST', '/api/glint/restore', { ids: items.map((i) => i.id) });
      removeLocal(restored.map((r) => r.id));
      toast(`${plural(restored.length, 'item')} restored`);
    } catch (err) { toast(err.message); }
  }

  async function deleteForever(items) {
    if (!await confirmBox({ title: 'Delete forever?', text: `${plural(items.length, 'item')} will be gone for good. This can’t be undone.`, ok: 'Delete forever', danger: true })) return;
    try {
      const { deleted, storage } = await gapi('POST', '/api/glint/trash/delete', { ids: items.map((i) => i.id) });
      G.storage = storage;
      removeLocal(deleted);
    } catch (err) { toast(err.message); }
  }

  async function emptyTrash() {
    if (!await confirmBox({ title: 'Empty the trash?', text: 'Every photo and video in the trash will be gone for good. This can’t be undone.', ok: 'Empty trash', danger: true })) return;
    try {
      const { storage } = await gapi('POST', '/api/glint/trash/delete', { all: true });
      G.storage = storage;
      G.items = [];
      render();
    } catch (err) { toast(err.message); }
  }

  // ---------- albums ----------

  async function newAlbum(items) {
    const name = await ask({ title: 'New album', value: '', ok: 'Create' });
    if (!name) return null;
    try {
      const { album } = await gapi('POST', '/api/glint/albums', { name, ids: items.map((i) => i.id) });
      if (items.length) { toast(`Added to “${album.name}”`); clearSel(); } else await load(true);
      return album;
    } catch (err) { toast(err.message); return null; }
  }

  async function albumPicker(items) {
    let albums = [];
    try { ({ albums } = await gapi('GET', '/api/glint/albums')); } catch (err) { toast(err.message); return; }
    const list = el('div', { class: 'nmove-list' },
      ...(albums.length ? albums.map((a) => el('button', {
        type: 'button',
        class: 'nmove-item',
        onclick: async () => {
          dialog.close();
          try {
            const { added } = await gapi('POST', `/api/glint/albums/${a.id}/add`, { ids: items.map((i) => i.id) });
            toast(added ? `Added to “${a.name}”` : `Already in “${a.name}”`);
            clearSel();
          } catch (err) { toast(err.message); }
        },
      }, gi('album'), el('span', { text: a.name }), el('span', { class: 'muted', text: String(a.count) })) ) : [el('div', { class: 'muted nmove-note', text: 'No albums yet' })]));
    showDialog(`Add ${plural(items.length, 'item')} to album`, [list], [
      el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => dialog.close() }),
      el('button', { type: 'button', class: 'btn small', text: 'New album', onclick: () => newAlbum(items) }),
    ]);
  }

  async function removeFromAlbum(items) {
    try {
      await gapi('POST', `/api/glint/albums/${G.album.id}/remove`, { ids: items.map((i) => i.id) });
      removeLocal(items.map((i) => i.id));
    } catch (err) { toast(err.message); }
  }

  async function renameAlbum() {
    const name = await ask({ title: 'Rename album', value: G.album.name, ok: 'Rename' });
    if (!name || name === G.album.name) return;
    try {
      const { album } = await gapi('PATCH', `/api/glint/albums/${G.album.id}`, { name });
      G.album.name = album.name;
      render();
    } catch (err) { toast(err.message); }
  }

  async function deleteAlbum() {
    if (!await confirmBox({ title: 'Delete album?', text: `“${G.album.name}” will be removed. The photos in it stay in Glint.`, ok: 'Delete album', danger: true })) return;
    try {
      await gapi('DELETE', `/api/glint/albums/${G.album.id}`);
      location.hash = `${base()}/albums`;
    } catch (err) { toast(err.message); }
  }

  function renderAlbums() {
    if (G.loading && !G.albums.length) {
      body.replaceChildren(el('div', { class: 'muted glint-note', text: 'Loading…' }));
      return;
    }
    if (!G.albums.length) {
      body.replaceChildren(el('div', { class: 'nest-empty' }, gi('album'), el('b', { text: 'No albums yet' }),
        el('span', { class: 'muted', text: 'Make one here, or select photos and choose Add to album.' })));
      return;
    }
    body.replaceChildren(el('div', { class: 'glint-albums' }, ...G.albums.map((a) => el('a', { class: 'galbum', href: `${base()}/album/${a.id}` },
      el('span', { class: 'galbum-cover' }, a.cover ? el('img', { src: thumbUrl({ id: a.cover }), alt: '', loading: 'lazy', draggable: 'false', onerror: (e) => e.target.remove() }) : gi('album')),
      el('b', { text: a.name }),
      el('span', { class: 'mono muted', text: plural(a.count, 'item') })))));
  }

  function renderTrash() {
    if (G.loading && !G.items.length) {
      body.replaceChildren(el('div', { class: 'muted glint-note', text: 'Loading…' }));
      return;
    }
    if (!G.items.length) {
      body.replaceChildren(el('div', { class: 'nest-empty' }, gi('trash'), el('b', { text: 'Trash is empty' }),
        el('span', { class: 'muted', text: 'Deleted photos wait here for 30 days.' })));
      return;
    }
    const left = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
    body.replaceChildren(el('p', { class: 'mono muted glint-note', text: 'Photos here are deleted for good after 30 days.' }),
      el('div', { class: 'glint-trash' }, ...G.items.map((p) => el('div', { class: `gtrash${G.sel.has(p.id) ? ' sel' : ''}`, 'data-id': p.id },
        el('button', { type: 'button', class: 'gtrash-pick', 'aria-label': `Select ${p.name}`, onclick: () => toggle(p.id) }, gi(G.sel.has(p.id) ? 'check' : p.name.match(/\.(mp4|mov|m4v|webm|3gp|mkv|avi|wmv|flv|mpe?g|mts|m2ts)$/i) ? 'play' : 'photo')),
        el('span', { class: 'gtrash-name', text: p.name }),
        el('span', { class: 'mono muted', text: `${plural(left(p.deletesAt), 'day')} left · ${bytes(p.size)}` }),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Restore', onclick: () => restore([p]) })))));
  }

  // ---------- Move to Glint (Google Takeout) ----------
  // The screen itself is shared with Nest's Move to Nest: public/move.js.

  const move = createMove({
    el, bytes, coarse, toast,
    noun: 'Glint',
    call: (method, path, body) => gapi(method, `/api/glint/import${path === '' ? '' : path}`, body),
    mount: () => body,
    showing: () => G.mode === 'move' && !view.classList.contains('hidden'),
    finished: () => { G.storage = null; },
    intro: 'Move your Google Photos library into Glint, on your own drive. Dates, albums and favourites carry over, and repeats are skipped.',
    steps: [
      ['Open ', el('a', { href: 'https://takeout.google.com/', target: '_blank', rel: 'noopener', text: 'takeout.google.com' }), ', choose Google Photos only, and export as .zip. Smaller zips (2 GB) and a few years at a time keep downloads easy.'],
      'Download the zips and add them here.',
      'Press Move to Glint. Keep the zips until you have looked through your photos.',
    ],
    stats: (c) => [[c.moved + c.nodate, 'moved'], [c.dup, 'already here'], [c.skipped, 'left in Google trash'], [c.problem, 'problems']],
    note: (c) => (c.nodate ? `${c.nodate.toLocaleString()} had no date from Google; they use the file date until you open them.` : ''),
    doneText: 'Look through Photos, then delete the zips to get the space back.',
    addZips: () => pickZips(),
    deleteZips: async (send) => {
      const ok = await confirmBox({
        title: 'Delete the zip files?',
        text: 'Do this once you have looked through your photos in Glint. The zips are deleted for good and the space comes back. Your photos stay.',
        ok: 'Delete the zips',
        danger: true,
      });
      if (ok) send('/delete-zips');
    },
  });
  const pollMove = () => move.poll();
  const loadMove = () => move.refresh();
  const renderMove = () => move.render();

  function pickZips() {
    const input = el('input', { type: 'file', accept: '.zip,application/zip', multiple: true, class: 'hidden' });
    input.addEventListener('change', () => { queueZips([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  function queueZips(files) {
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    if (zips.length < files.length) toast('Only the .zip files from Google Takeout can be added here.');
    for (const file of zips) UP.tasks.push({ file, space: G.space, name: file.name, size: file.size, zip: true, sent: 0, live: 0, state: 'queued' });
    renderPanel();
    pump();
  }

  // ---------- viewer ----------

  const V = { open: false, i: 0, root: null, touch: null };

  function openViewer(i) {
    if (i < 0) return;
    V.open = true;
    V.i = i;
    if (!V.root) buildViewer();
    document.body.classList.add('gview-open');
    V.root.classList.remove('hidden');
    showPhoto();
    V.root.focus();
  }

  function closeViewer() {
    if (!V.open) return;
    fileInfo.close();
    V.open = false;
    V.root.classList.add('hidden');
    V.stage.replaceChildren();
    document.body.classList.remove('gview-open');
    const last = G.items[V.i];
    const t = last && body.querySelector(`.gtile[data-id="${last.id}"]`);
    if (t) t.scrollIntoView({ block: 'nearest' });
  }

  function buildViewer() {
    V.stage = el('div', { class: 'gview-stage' });
    V.title = el('div', { class: 'gview-title' });
    V.fav = el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Favourite', onclick: () => favouriteCurrent() });
    V.prev = el('button', { type: 'button', class: 'gview-nav prev', 'aria-label': 'Previous', onclick: () => step(-1) }, gi('left'));
    V.next = el('button', { type: 'button', class: 'gview-nav next', 'aria-label': 'Next', onclick: () => step(1) }, gi('right'));
    V.root = el('div', { class: 'gview hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer', tabindex: '-1' },
      el('div', { class: 'gview-bar' },
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Close', onclick: closeViewer }, gi('close')),
        V.title,
        V.fav,
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Info', onclick: showInfo }, gi('info')),
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Set date', onclick: () => setDate([G.items[V.i]]) }, gi('calendar')),
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Add to album', onclick: () => albumPicker([G.items[V.i]]) }, gi('album')),
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Download', onclick: () => download([G.items[V.i]]) }, gi('download')),
        el('button', { type: 'button', class: 'gview-btn', 'aria-label': 'Delete', onclick: deleteCurrent }, gi('trash'))),
      V.stage, V.prev, V.next);
    document.body.append(V.root);

    V.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'i' || e.key === 'I') showInfo();
      else if (e.key === 'Tab') { e.preventDefault(); } // keep focus on the viewer itself
    });
    // Swipe sideways to change photo, down to close.
    V.stage.addEventListener('touchstart', (e) => {
      V.touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    V.stage.addEventListener('touchend', (e) => {
      if (!V.touch) return;
      const dx = e.changedTouches[0].clientX - V.touch.x;
      const dy = e.changedTouches[0].clientY - V.touch.y;
      V.touch = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      else if (dy > 90 && dy > Math.abs(dx) * 1.5) closeViewer();
    }, { passive: true });
    V.stage.addEventListener('click', (e) => { if (e.target === V.stage) closeViewer(); });
  }

  function showPhoto() {
    const p = G.items[V.i];
    if (!p) return closeViewer();
    V.title.replaceChildren(el('b', { text: dayName(p.taken) }), el('span', { class: 'mono muted', text: `${p.name} · ${bytes(p.size)}${p.w ? ` · ${p.w}×${p.h}` : ''}` }));
    V.fav.replaceChildren(gi(p.fav ? 'starFill' : 'star'));
    V.fav.setAttribute('aria-label', p.fav ? 'Unfavourite' : 'Favourite');
    V.prev.classList.toggle('hidden', V.i === 0);
    V.next.classList.toggle('hidden', V.i >= G.items.length - 1 && !G.next);
    const node = p.live ? liveView(p) : p.video
      ? el('video', { src: mediaUrl(p), controls: true, autoplay: true, playsinline: true, preload: 'metadata', class: 'gview-media' })
      : el('img', { src: mediaUrl(p), alt: p.name, class: 'gview-media', draggable: 'false' });
    // A format this browser can't show (HEIC on Windows) offers the download instead.
    // The server makes (once) and sends a JPEG or MP4 copy when it can; the original is never changed.
    let converted = false;
    node.addEventListener('error', () => {
      if (!converted) {
        converted = true;
        node.src = mediaUrl(p, true);
        return;
      }
      V.stage.replaceChildren(el('div', { class: 'gview-fail' }, el('b', { text: 'This browser can’t show this file' }),
        el('button', { type: 'button', class: 'btn small', text: 'Download it', onclick: () => download([p]) })));
    });
    V.stage.replaceChildren(node);
    // Keep the next page coming while paging through the last few photos.
    if (G.next && !G.loading && V.i > G.items.length - 6) load(false);
    // Warm up the neighbour so swiping is instant.
    const n = G.items[V.i + 1];
    if (n && !n.video && !n.live) new Image().src = mediaUrl(n);
  }

  // A Live Photo: the picture, with its clip played while the picture or the LIVE button is held.
  function liveView(p) {
    const img = el('img', { src: mediaUrl(p), alt: p.name, class: 'gview-media', draggable: 'false' });
    const clip = el('video', { src: sp(`/api/glint/media/${p.live}`), muted: true, playsinline: true, loop: true, preload: 'none', class: 'gview-media gview-clip hidden' });
    clip.muted = true;
    const badge = el('button', { type: 'button', class: 'gview-live mono', text: 'LIVE', 'aria-label': 'Hold to play' });
    const wrap = el('div', { class: 'gview-livewrap' }, img, clip, badge);
    let timer = 0;
    const play = () => { clip.classList.remove('hidden'); clip.currentTime = 0; clip.play().catch(() => {}); };
    const stop = () => { clearTimeout(timer); clip.pause(); clip.classList.add('hidden'); };
    badge.addEventListener('pointerdown', (e) => { e.preventDefault(); play(); });
    // On the picture itself a short hold starts it, so a swipe still changes photo.
    img.addEventListener('pointerdown', () => { timer = setTimeout(play, 350); });
    for (const t of [badge, img]) for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) t.addEventListener(ev, stop);
    wrap.addEventListener('contextmenu', (e) => e.preventDefault());
    // The wrapper takes the media's place, so the failure message still shows if the picture can't be drawn.
    img.addEventListener('error', () => wrap.dispatchEvent(new Event('error')));
    return wrap;
  }

  async function step(d) {
    if (V.i + d < 0) return;
    if (V.i + d >= G.items.length) {
      if (!G.next) return;
      if (!G.loading) await load(false);
      if (V.i + d >= G.items.length) return;
    }
    V.i += d;
    showPhoto();
  }

  function showInfo() {
    const p = G.items[V.i];
    if (p) fileInfo.open(p.id, G.space, 'glint');
  }

  async function favouriteCurrent() {
    const p = G.items[V.i];
    if (!p) return;
    await favourite([p], !p.fav);
    if (V.open) showPhoto();
  }

  async function deleteCurrent() {
    const p = G.items[V.i];
    if (!p) return;
    await trash([p]);
    if (!G.items.length) return closeViewer();
    V.i = Math.min(V.i, G.items.length - 1);
    showPhoto();
  }

  // ---------- previews: dates and small pictures, made in this browser ----------

  const thumbQueue = [];
  let thumbBusy = 0;
  const tileObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      tileObserver.unobserve(e.target);
      const p = byId(e.target.dataset.id);
      if (p && !p.making) { p.making = true; thumbQueue.push({ p }); }
    }
    pumpThumbs();
  }, { rootMargin: '300px' });

  function pumpThumbs() {
    while (thumbBusy < 2 && thumbQueue.length) {
      const job = thumbQueue.shift();
      thumbBusy++;
      makePreview(job.p, job.file).catch(() => {}).finally(() => { thumbBusy--; pumpThumbs(); });
    }
  }

  // EXIF "taken" time from the start of a JPEG: DateTimeOriginal, or DateTime.
  function exifDate(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 12 || v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      if (v.getUint8(o) !== 0xff) return null;
      const marker = v.getUint8(o + 1);
      const len = v.getUint16(o + 2);
      if (marker === 0xe1 && v.getUint32(o + 4) === 0x45786966) return readTiff(v, o + 10, Math.min(v.byteLength, o + 2 + len));
      if (marker === 0xda) return null;
      o += 2 + len;
    }
    return null;
  }

  function readTiff(v, base, end) {
    const little = v.getUint16(base) === 0x4949;
    const u16 = (o) => v.getUint16(base + o, little);
    const u32 = (o) => v.getUint32(base + o, little);
    const text = (o, n) => {
      let s = '';
      for (let i = 0; i < n - 1 && base + o + i < end; i++) s += String.fromCharCode(v.getUint8(base + o + i));
      return s;
    };
    const tags = (ifd) => {
      const out = {};
      if (base + ifd + 2 > end) return out;
      const n = u16(ifd);
      for (let i = 0; i < n && base + ifd + 2 + i * 12 + 12 <= end; i++) {
        const e = ifd + 2 + i * 12;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return out;
    };
    const ascii = (t) => (t && t.type === 2 ? text(t.count > 4 ? u32(t.at) : t.at, t.count) : '');
    const first = tags(u32(4));
    const sub = first[0x8769] ? tags(u32(first[0x8769].at)) : {};
    const raw = ascii(sub[0x9003]) || ascii(sub[0x9004]) || ascii(first[0x132]);
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(raw);
    if (!m || m[1] === '0000') return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  // A file's own modified time, when it has a real one.
  function fileDate(file) {
    return file && file.lastModified > 86400000 ? file.lastModified : null;
  }

  function toJpeg(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
  }

  const THUMB = 320; // pixels on the long side; tiles show them at up to ~200

  function drawSmall(source, w, h) {
    const k = Math.min(1, THUMB / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // Reads one photo or video (from the File just uploaded, or from the server
  // for older ones) and sends back its date, size and preview.
  async function imageFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) throw new Error('empty');
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  async function makePreview(p, file) {
    let blob = file;
    let taken = null;
    let exif = false;
    let w = 0;
    let h = 0;
    let dur = 0;
    let jpeg = null;
    try {
      if (!blob) {
        const res = await fetch(mediaUrl(p), p.video ? { headers: { Range: 'bytes=0-262143' } } : {});
        if (!res.ok && res.status !== 206) throw new Error('unavailable');
        if (p.video) taken = null; // a video's date is its upload time unless the File says otherwise
        else blob = await res.blob();
      }
      if (blob && !p.video) {
        taken = exifDate(await blob.slice(0, 131072).arrayBuffer());
        exif = taken !== null;
        if (taken === null) taken = fileDate(file);
        let bmp;
        try {
          bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch {
          // An iPhone can show HEIC in an image even when createImageBitmap won't take it: try that before asking the server.
          bmp = await imageFromBlob(blob).catch(() => null);
          if (!bmp) {
            // HEIC on Windows and the like: draw from the server's JPEG copy instead.
            const conv = await fetch(mediaUrl(p, true));
            if (!conv.ok) throw new Error('unavailable');
            bmp = await createImageBitmap(await conv.blob(), { imageOrientation: 'from-image' });
          }
        }
        w = bmp.width || bmp.naturalWidth;
        h = bmp.height || bmp.naturalHeight;
        jpeg = await toJpeg(drawSmall(bmp, w, h));
        if (bmp.close) bmp.close();
      } else if (p.video) {
        const out = await videoPreview(file ? file : null, p);
        ({ w, h, dur } = out);
        jpeg = out.jpeg;
        taken = fileDate(file);
      }
    } catch {
      jpeg = null; // can't be drawn here; the tile keeps its placeholder
    }
    const q = new URLSearchParams();
    if (taken !== null) q.set('taken', String(taken));
    if (exif) q.set('exif', '1');
    if (w) { q.set('w', String(w)); q.set('h', String(h)); }
    if (dur) q.set('dur', String(dur));
    const res = await fetch(sp(`/api/glint/photos/${p.id}/preview?${q}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      credentials: 'same-origin',
      body: jpeg || new Blob([]),
    });
    if (!res.ok) return;
    const { item } = await res.json();
    Object.assign(p, item);
    p.making = false;
    const t = body.querySelector(`.gtile[data-id="${p.id}"]`);
    if (G.mode === 'undated' && !p.undated) { removeLocal([p.id]); return; }
    if (t) t.replaceWith(tile(p));
    // A new date can change where the photo belongs; the next load puts it in order.
    if (taken !== null) reloadSoon();
  }

  function videoPreview(file, p) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const url = file ? URL.createObjectURL(file) : mediaUrl(p);
      const done = (fn, val) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); if (file) URL.revokeObjectURL(url); fn(val); };
      const timer = setTimeout(() => done(reject, new Error('timeout')), 90000);
      let converted = false;
      v.addEventListener('error', () => {
        // MKV, 3GP and the like: draw from the server's MP4 copy (made once) instead.
        if (!converted) { converted = true; v.src = mediaUrl(p, true); return; }
        done(reject, new Error('unsupported'));
      });
      v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); });
      v.addEventListener('seeked', async () => {
        try {
          const jpeg = await toJpeg(drawSmall(v, v.videoWidth, v.videoHeight));
          done(resolve, { jpeg, w: v.videoWidth, h: v.videoHeight, dur: v.duration || 0 });
        } catch (err) { done(reject, err); }
      }, { once: true });
      v.src = url;
    });
  }

  // ---------- uploads ----------

  const UP = { tasks: [], running: 0, max: 3 };
  const panel = el('div', { class: 'card nup hidden', role: 'region', 'aria-label': 'Photo uploads' });
  document.body.append(panel);

  async function queueUploads(files) {
    const media = files.filter((f) => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|mp4|mov|m4v|webm|3gp|mkv|avi|wmv|flv|mpe?g|mts|m2ts)$/i.test(f.name));
    const skippedType = files.length - media.length;
    const space = G.space;
    if (!media.length) { if (skippedType) toast('Glint takes photos and videos. Use Files for everything else.'); return; }
    let exists = [];
    try {
      ({ exists } = await gapi('POST', '/api/glint/check', { files: media.map((f) => ({ name: f.name, size: f.size })) }));
    } catch { /* the check is a courtesy; upload anyway */ }
    const fresh = media.filter((_, i) => !exists[i]);
    const dupes = media.length - fresh.length;
    if (dupes || skippedType) {
      toast([dupes ? `${plural(dupes, 'photo')} already in Glint, skipped` : '', skippedType ? `${plural(skippedType, 'file')} weren’t photos or videos` : ''].filter(Boolean).join(' · '));
    }
    for (const file of fresh) UP.tasks.push({ file, space, name: file.name, size: file.size, sent: 0, live: 0, state: 'queued' });
    renderPanel();
    pump();
  }

  // A phone that goes to sleep mid-upload stops it, so keep the screen on while
  // photos are sending (browsers without the feature just skip this).
  let awake = null;
  async function keepAwake() {
    const busy = UP.tasks.some((x) => x.state === 'uploading' || x.state === 'queued');
    if (!busy) {
      if (awake) awake.release().catch(() => {});
      awake = null;
      return;
    }
    if (awake || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      awake = await navigator.wakeLock.request('screen');
      awake.addEventListener('release', () => { awake = null; });
    } catch { /* low battery or not allowed: uploads still run */ }
  }
  document.addEventListener('visibilitychange', keepAwake);

  function pump() {
    keepAwake();
    while (UP.running < UP.max) {
      const t = UP.tasks.find((x) => x.state === 'queued');
      if (!t) break;
      UP.running++;
      runUpload(t).finally(() => { UP.running--; renderPanel(); pump(); });
    }
  }

  async function runUpload(t) {
    t.state = 'uploading';
    t.error = '';
    renderPanel();
    try {
      if (!t.id) {
        const year = new Date(t.file.lastModified || Date.now()).getFullYear();
        const s = await gapi('POST', '/api/glint/uploads', t.zip ? { name: t.name, size: t.size, type: 'application/zip', importZip: true } : { name: t.name, size: t.size, type: t.file.type, year }, t.space);
        if (s.done) return finish(t, s.item);
        Object.assign(t, { id: s.id, chunk: s.chunkSize, sent: s.received });
      }
      while (t.sent < t.size) {
        if (t.state !== 'uploading') return;
        const r = await putChunk(t, t.file.slice(t.sent, Math.min(t.size, t.sent + t.chunk)));
        t.sent = r.received;
        t.live = t.sent;
        paintHead();
        if (r.done) return finish(t, r.item);
      }
    } catch (err) {
      if (t.state === 'cancelled') return;
      t.state = 'failed';
      t.error = err.message;
      t.overLimit = err.code === 'over-limit';
      // Nothing else will fit either: stop the rest instead of failing them one by one.
      if (t.overLimit) for (const o of UP.tasks) if (o.state === 'queued') { o.state = 'failed'; o.error = t.error; o.overLimit = true; }
    }
  }

  // Where to get more space: admins raise their own limit, everyone else asks.
  function moreSpace() {
    if (G.space) return state.user.role === 'admin' ? { href: '#/admin', text: 'Raise family limit' } : { href: base(), text: 'Ask an admin to raise the family limit' };
    return state.user && state.user.role === 'admin'
      ? { href: '#/admin', text: 'Raise limit' }
      : { href: '#/profile', text: 'Ask for more' };
  }

  function finish(t, item) {
    t.state = 'done';
    t.sent = t.live = t.size;
    if (t.zip) { if (G.mode === 'move') loadMove(); return; }
    // Make its date and preview now, while this browser still has the file.
    const p = { id: item.id, name: item.name, size: item.size, video: /^video\//.test(t.file.type) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(item.name), taken: Date.now(), thumb: 0, fav: false };
    thumbQueue.push({ p, file: t.file });
    pumpThumbs();
    reloadSoon();
  }

  let reloadTimer = null;
  // Back in order after dates changed (the viewer keeps its place; the list catches up when it closes).
  function refresh() {
    if (V.open) { showPhoto(); return; }
    reloadNow();
  }

  function reloadNow() {
    if (!['photos', 'favourites', 'undated'].includes(G.mode)) return;
    G.items = []; G.next = null; G.total = 0; G.sel.clear();
    render();
    load(true);
  }

  function reloadSoon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!['photos', 'favourites'].includes(G.mode)) return;
      // Wait until uploads and previews settle, so the list doesn't jump while they run.
      if (UP.tasks.some((x) => x.state === 'uploading' || x.state === 'queued') || thumbBusy || thumbQueue.length) return reloadSoon();
      load(true);
    }, 1500);
  }

  function sendChunk(t, blob) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      t.xhr = x;
      x.open('PUT', sp(`/api/glint/uploads/${t.id}?offset=${t.sent}`, t.space));
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => { t.live = t.sent + e.loaded; paintHead(); };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status === 200 || (x.status === 409 && Number.isInteger(d.received))) return resolve(d);
        const err = Object.assign(new Error(d.error || `Upload failed (${x.status})`), { code: d.code });
        err.fatal = [400, 401, 403, 404, 413, 507].includes(x.status);
        reject(err);
      };
      x.onerror = () => reject(new Error('Connection lost'));
      x.onabort = () => reject(Object.assign(new Error('Cancelled'), { fatal: true }));
      x.send(blob);
    });
  }

  async function putChunk(t, blob) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendChunk(t, blob);
      } catch (err) {
        if (err.fatal || attempt >= 6 || t.state !== 'uploading') throw err;
        t.error = 'Reconnecting…';
        paintHead();
        await sleep(1000 * 2 ** Math.min(attempt, 4));
        t.error = '';
      }
    }
  }

  function cancelAll() {
    for (const t of UP.tasks) {
      const was = t.state;
      if (t.state === 'queued' || t.state === 'uploading') t.state = 'cancelled';
      if (t.xhr && was === 'uploading') t.xhr.abort();
      if (t.id && was === 'uploading') setTimeout(() => gapi('DELETE', `/api/glint/uploads/${t.id}`, undefined, t.space).catch(() => {}), 300);
    }
    UP.tasks = UP.tasks.filter((t) => t.state === 'done' || t.state === 'failed');
    renderPanel();
  }

  function retryFailed() {
    for (const t of UP.tasks) if (t.state === 'failed') t.state = 'queued';
    renderPanel();
    pump();
  }

  let tidyTimer = null;
  function paintHead() {
    const h = panel.querySelector('.nup-title');
    const bar = panel.querySelector('.meter i');
    const sub = panel.querySelector('.nup-status');
    if (!h) return;
    const tasks = UP.tasks;
    const total = tasks.reduce((a, t) => a + t.size, 0);
    const sent = tasks.reduce((a, t) => a + (t.state === 'done' ? t.size : t.live), 0);
    const pct = total ? Math.floor((sent / total) * 100) : 100;
    const active = tasks.filter((t) => t.state === 'uploading' || t.state === 'queued');
    const failed = tasks.filter((t) => t.state === 'failed');
    const done = tasks.filter((t) => t.state === 'done').length;
    const what = tasks.every((t) => t.zip) ? 'zip' : 'photo';
    h.textContent = active.length ? `Uploading ${done + 1} of ${tasks.length}` : failed.length ? `${plural(failed.length, 'upload')} failed` : `${plural(done, what)} uploaded`;
    bar.style.width = `${active.length ? pct : 100}%`;
    sub.textContent = failed.length && !active.length ? failed[0].error : active.length ? `${bytes(sent)} of ${bytes(total)}${active.some((t) => t.error) ? ' · Reconnecting…' : ''}` : tasks.every((t) => t.zip) ? 'Ready to move' : 'Previews are being made';
  }

  function renderPanel() {
    clearTimeout(tidyTimer);
    document.body.classList.toggle('nup-open', UP.tasks.length > 0);
    if (!UP.tasks.length) { panel.classList.add('hidden'); return; }
    const busy = UP.tasks.some((t) => t.state === 'uploading' || t.state === 'queued');
    const failed = UP.tasks.some((t) => t.state === 'failed');
    const full = UP.tasks.some((t) => t.state === 'failed' && t.overLimit);
    panel.replaceChildren(
      el('div', { class: 'nup-head' }, el('b', { class: 'nup-title' }),
        busy ? el('button', { type: 'button', class: 'link-btn mono', text: 'Cancel', onclick: cancelAll })
          : el('button', { type: 'button', class: 'nup-x', 'aria-label': 'Close', onclick: () => { UP.tasks = []; renderPanel(); } }, gi('close'))),
      el('div', { class: 'glint-up' },
        el('div', { class: 'meter' }, el('i', { style: 'width:0' })),
        el('div', { class: 'nup-status mono muted' }),
        failed && !busy ? (full ? el('a', { class: 'link-btn mono', ...moreSpace() }) : el('button', { type: 'button', class: 'link-btn mono', text: 'Retry', onclick: retryFailed })) : null));
    panel.classList.remove('hidden');
    paintHead();
    if (!busy && !failed) {
      tidyTimer = setTimeout(() => { if (!UP.tasks.some((t) => t.state !== 'done')) { UP.tasks = []; renderPanel(); } }, 5000);
    }
  }

  addEventListener('beforeunload', (e) => {
    if (UP.tasks.some((t) => t.state === 'uploading' || t.state === 'queued')) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- picking and dropping ----------

  const pick = $('#glint-pick');
  $('#glint-upload').addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => { queueUploads([...pick.files]); pick.value = ''; });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const drop = $('#glint-drop');
  const inGlint = () => !view.classList.contains('hidden');
  addEventListener('dragenter', (e) => { if (inGlint() && hasFiles(e)) { dragDepth++; drop.classList.remove('hidden'); } });
  addEventListener('dragleave', (e) => { if (inGlint() && hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; drop.classList.add('hidden'); } });
  addEventListener('dragover', (e) => { if (inGlint() && hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (!inGlint() || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.classList.add('hidden');
    if (G.mode === 'move') queueZips([...e.dataTransfer.files]);
    else queueUploads([...e.dataTransfer.files]);
  });
}());
