'use strict';

// Nest: My Drive and Trash. Plain JS, no build step. Loaded after app.js and
// uses its helpers ($, el, api, bytes).
//
// Mouse: click selects (Ctrl/Cmd adds, Shift picks a range), double-click
// opens, right-click or ⋯ shows actions, drag onto a folder moves.
// Touch: tap opens, long-press starts selecting, ⋯ shows actions.

(function nest() {
  const NI = {
    folder: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M3 10.5h18"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h6"/>',
    image: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 2.5-2.5L20 17"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
    audio: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    archive: '<path d="M6 3h12v18H6z"/><path d="M11 3v2h2v2h-2v2h2v2h-2"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
    list: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    move: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M10 14h6M13.5 11.5L16 14l-2.5 2.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    folderPlus: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M12 11.5v5M9.5 14h5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };

  function ni(name, cls = '') {
    const s = el('span', { class: `ni ${cls}`, 'aria-hidden': 'true' });
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${NI[name]}</svg>`;
    return s;
  }

  const EXT = {
    image: /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg|raw|cr2|nef|dng)$/i,
    video: /\.(mp4|mov|m4v|mkv|webm|avi|wmv|3gp)$/i,
    audio: /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i,
    archive: /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso)$/i,
    doc: /\.(pdf|docx?|odt|rtf|txt|md|pages|xlsx?|ods|csv|pptx?|odp|key|numbers)$/i,
  };

  function kindIcon(it) {
    if (it.kind === 'folder') return 'folder';
    const m = it.mime || '';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    for (const [k, re] of Object.entries(EXT)) if (re.test(it.name)) return k;
    return 'file';
  }

  function when(ms) {
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const coarse = matchMedia('(pointer: coarse)');
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const label = (items) => (items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item'));

  // ---------- state ----------

  const prefs = { view: 'list', sort: 'name', dir: 'asc' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nest.prefs') || '{}')); } catch { /* private mode */ }
  const savePrefs = () => { try { localStorage.setItem('nest.prefs', JSON.stringify(prefs)); } catch { /* ignore */ } };

  const N = {
    mode: 'drive', // or 'trash'
    folderId: 'root',
    folder: { id: 'root', name: 'My Drive' },
    path: [],
    items: [],
    more: false,
    total: 0,
    sel: new Set(),
    anchor: null,
    storage: null,
    days: 30,
    token: 0,
    loadingMore: false,
  };

  const list = $('#nest-list');
  const view = $('#view-nest');
  const byId = (id) => N.items.find((i) => i.id === id);
  const selected = () => N.items.filter((i) => N.sel.has(i.id));

  // ---------- loading ----------

  window.nestOpen = (parts) => {
    const mode = parts[0] === 'trash' ? 'trash' : 'drive';
    const folderId = mode === 'drive' && parts[0] === 'f' && parts[1] ? parts[1] : 'root';
    const same = mode === N.mode && folderId === N.folderId;
    N.mode = mode;
    N.folderId = folderId;
    // #/nest/f/<folder>/<file> (from search) opens the folder with that file picked out.
    N.focus = mode === 'drive' && parts[0] === 'f' && parts[2] ? parts[2] : null;
    if (!same) {
      N.sel.clear();
      N.items = [];
      N.path = [];
      N.folder = { id: folderId, name: folderId === 'root' ? 'My Drive' : '' };
      render();
    }
    load(same ? N.items.length : 0);
  };

  function folderUrl(id) {
    return id === 'root' || !id ? '#/nest' : `#/nest/f/${id}`;
  }

  async function fetchPage(offset) {
    return api('GET', `/api/nest/folders/${N.folderId}?sort=${prefs.sort}&dir=${prefs.dir}&offset=${offset}`);
  }

  // Loads the folder again, keeping at least `keep` items so the scroll position holds.
  async function load(keep = 0) {
    const t = ++N.token;
    try {
      if (N.mode === 'trash') {
        const d = await api('GET', '/api/nest/trash');
        if (t !== N.token) return;
        Object.assign(N, { items: d.items, more: false, total: d.items.length, storage: d.storage, days: d.days });
      } else {
        let items = [];
        let d;
        do {
          d = await fetchPage(items.length);
          if (t !== N.token) return;
          items = items.concat(d.items);
        } while (d.more && (items.length < keep || (N.focus && !items.some((i) => i.id === N.focus))));
        Object.assign(N, { folder: d.folder, path: d.path, items, more: d.more, total: d.total, storage: d.storage });
      }
    } catch (err) {
      if (t !== N.token) return;
      if (N.mode === 'drive' && N.folderId !== 'root') {
        toast(err.message);
        location.hash = '#/nest';
        return;
      }
      toast(err.message);
    }
    for (const id of [...N.sel]) if (!byId(id)) N.sel.delete(id);
    const focus = N.focus && byId(N.focus) ? N.focus : null;
    N.focus = null;
    if (focus) N.sel = new Set([focus]);
    render();
    if (focus) {
      selectOnly(focus);
      const row = list.querySelector(`[data-id="${CSS.escape(focus)}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }

  async function loadMore() {
    if (!N.more || N.loadingMore || N.mode !== 'drive') return;
    N.loadingMore = true;
    const t = N.token;
    try {
      const d = await fetchPage(N.items.length);
      if (t !== N.token) return;
      N.items = N.items.concat(d.items);
      N.more = d.more;
      renderList();
    } catch (err) {
      toast(err.message);
    } finally {
      N.loadingMore = false;
    }
  }

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: '600px' }).observe($('#nest-sentinel'));

  let reloadTimer = null;
  function reloadSoon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { if (!view.classList.contains('hidden')) load(N.items.length); }, 400);
  }

  // ---------- rendering ----------

  function render() {
    const trash = N.mode === 'trash';
    document.querySelectorAll('.nest-places a').forEach((a) => {
      const on = a.dataset.place === N.mode;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#nest-new').classList.toggle('hidden', trash);
    $('#nest-tools').classList.toggle('hidden', trash);
    $('#nest-empty-trash').classList.toggle('hidden', !trash || !N.items.length);
    renderCrumbs();
    renderStorage();
    renderTools();
    renderList();
  }

  function renderCrumbs() {
    const c = $('#nest-crumbs');
    if (N.mode === 'trash') {
      c.replaceChildren(el('h2', { text: 'Trash' }));
      return;
    }
    const trail = [{ id: 'root', name: 'My Drive' }, ...N.path];
    const parts = [];
    trail.forEach((p, i) => {
      const last = i === trail.length - 1;
      if (i) parts.push(ni('chevron', 'crumb-sep'));
      parts.push(last
        ? el('h2', { text: p.name || '…', 'aria-current': 'page' })
        : el('a', { class: 'crumb', href: folderUrl(p.id), text: p.name, 'data-drop': p.id }));
    });
    c.replaceChildren(...parts);
    c.scrollLeft = c.scrollWidth;
    document.title = `${trail[trail.length - 1].name || 'Files'} · ${state.serverName}`;
  }

  function renderStorage() {
    const s = N.storage;
    if (!s) return;
    const pctUsed = s.limitBytes ? Math.min(100, (s.usedBytes / s.limitBytes) * 100) : 0;
    const bar = $('#nest-meter');
    bar.style.width = `${s.limitBytes ? Math.max(pctUsed, 1) : 0}%`;
    bar.parentNode.classList.toggle('high', pctUsed >= 90);
    bar.parentNode.classList.toggle('hidden', !s.limitBytes);
    $('#nest-used').textContent = s.limitBytes ? `${bytes(s.usedBytes)} of ${bytes(s.limitBytes)} used` : `${bytes(s.usedBytes)} used`;
  }

  function renderTools() {
    $('#nest-sort').value = prefs.sort;
    $('#nest-dir').replaceChildren(ni(prefs.dir === 'asc' ? 'up' : 'down'));
    $('#nest-dir').setAttribute('aria-label', prefs.dir === 'asc' ? 'Ascending, tap to reverse' : 'Descending, tap to reverse');
    document.querySelectorAll('[data-view-mode]').forEach((b) => {
      b.replaceChildren(ni(b.dataset.viewMode));
      b.setAttribute('aria-pressed', String(prefs.view === b.dataset.viewMode));
    });
    const grid = prefs.view === 'grid' && N.mode === 'drive';
    list.classList.toggle('grid', grid);
    const cols = $('#nest-cols');
    cols.classList.toggle('hidden', grid || !N.items.length);
    const head = (key, text) => (N.mode === 'drive'
      ? el('button', { type: 'button', class: `col-${key}${prefs.sort === key ? ' on' : ''}`, onclick: () => sortBy(key) },
        text, prefs.sort === key ? ni(prefs.dir === 'asc' ? 'up' : 'down') : null)
      : el('span', { class: `col-${key}`, text }));
    cols.replaceChildren(
      el('span', { class: 'col-icon' }),
      head('name', 'Name'),
      N.mode === 'trash' ? el('span', { class: 'col-modified', text: 'Deleted in' }) : head('modified', 'Modified'),
      head('size', 'Size'),
      el('span', { class: 'col-more' }));
  }

  function sortBy(key) {
    if (prefs.sort === key) prefs.dir = prefs.dir === 'asc' ? 'desc' : 'asc';
    else Object.assign(prefs, { sort: key, dir: key === 'name' ? 'asc' : 'desc' });
    savePrefs();
    renderTools();
    load();
  }

  function rowFor(it) {
    const trash = N.mode === 'trash';
    const size = it.kind === 'folder' ? '—' : bytes(it.size);
    const date = trash ? daysLeft(it) : when(it.modified);
    const r = el('div', {
      class: `nrow${it.kind === 'folder' ? ' folder' : ''}${N.sel.has(it.id) ? ' sel' : ''}`,
      'data-id': it.id,
      role: 'option',
      'aria-selected': String(N.sel.has(it.id)),
      draggable: !trash && !coarse.matches ? 'true' : null,
      'data-drop': it.kind === 'folder' && !trash ? it.id : null,
    },
    el('span', { class: 'ntype' }, ni(kindIcon(it)), ni('check', 'ntick')),
    el('span', { class: 'nname', text: it.name, title: it.name }),
    el('span', { class: 'nsub mono muted', text: it.kind === 'folder' ? date : `${date} · ${size}` }),
    el('span', { class: 'ndate mono muted', text: date }),
    el('span', { class: 'nsize mono muted', text: size }),
    el('button', { type: 'button', class: 'nmore', 'aria-label': `Actions for ${it.name}` }, ni('more')));
    return r;
  }

  function daysLeft(it) {
    const d = Math.max(0, Math.ceil((it.deletesAt - Date.now()) / 86400000));
    return d === 1 ? '1 day' : `${d} days`;
  }

  function renderList() {
    if (!N.items.length) {
      const msg = N.mode === 'trash'
        ? ['Trash is empty', `Items in the trash are deleted forever after ${N.days} days.`]
        : N.folderId === 'root'
          ? ['Your drive is empty', coarse.matches ? 'Tap + to upload files or make a folder.' : 'Drop files and folders here, or use New.']
          : ['This folder is empty', coarse.matches ? 'Tap + to add files.' : 'Drop files here, or use New.'];
      list.replaceChildren(el('div', { class: 'nest-empty' }, ni(N.mode === 'trash' ? 'trash' : 'folder'), el('b', { text: msg[0] }), el('span', { class: 'muted', text: msg[1] })));
    } else {
      list.replaceChildren(...N.items.map(rowFor));
    }
    $('#nest-cols').classList.toggle('hidden', !N.items.length || list.classList.contains('grid'));
    paintSelection();
  }

  function paintSelection() {
    list.querySelectorAll('.nrow').forEach((r) => {
      const on = N.sel.has(r.dataset.id);
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
    });
    list.classList.toggle('selecting', N.sel.size > 0);
    const bar = $('#nest-selbar');
    if (!N.sel.size) {
      bar.classList.add('hidden');
      return;
    }
    const items = selected();
    const btn = (name, text, run, cls = '') => el('button', { type: 'button', class: `nsel-btn ${cls}`, onclick: run, title: text }, ni(name), el('span', { text }));
    const actions = N.mode === 'trash'
      ? [btn('restore', 'Restore', () => restore(items)), btn('trash', 'Delete forever', () => deleteForever(items), 'danger')]
      : [btn('download', 'Download', () => download(items)), btn('move', 'Move', () => moveDialog(items)), btn('trash', 'Trash', () => trash(items))];
    bar.replaceChildren(
      el('button', { type: 'button', class: 'nsel-btn', onclick: clearSel, 'aria-label': 'Clear selection' }, ni('close')),
      el('span', { class: 'nsel-count', text: `${items.length} selected` }),
      el('span', { class: 'nsel-actions' }, ...actions),
      el('button', { type: 'button', class: 'nsel-btn nsel-more', onclick: (e) => openMenu(actionsFor(items), e.currentTarget, label(items)), 'aria-label': 'More actions' }, ni('more')));
    bar.classList.remove('hidden');
  }

  // ---------- selection ----------

  function selectOnly(id) {
    N.sel = new Set(id ? [id] : []);
    N.anchor = id;
    paintSelection();
  }

  function toggle(id) {
    if (N.sel.has(id)) N.sel.delete(id); else N.sel.add(id);
    N.anchor = id;
    paintSelection();
  }

  function selectRange(id) {
    const a = N.items.findIndex((i) => i.id === N.anchor);
    const b = N.items.findIndex((i) => i.id === id);
    if (a < 0 || b < 0) return selectOnly(id);
    const [from, to] = a < b ? [a, b] : [b, a];
    N.sel = new Set(N.items.slice(from, to + 1).map((i) => i.id));
    paintSelection();
  }

  function clearSel() {
    N.sel.clear();
    paintSelection();
  }

  // ---------- pointer and keyboard ----------

  let pressTimer = null;
  let pressed = false;
  let pressAt = null;

  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const r = e.target.closest('.nrow');
    if (!r || e.target.closest('.nmore')) return;
    pressAt = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => {
      pressed = true;
      if (navigator.vibrate) navigator.vibrate(10);
      toggle(r.dataset.id);
    }, 450);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  list.addEventListener('pointerup', cancelPress);
  list.addEventListener('pointercancel', cancelPress);
  list.addEventListener('pointermove', (e) => {
    if (pressAt && Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 10) cancelPress();
  });

  list.addEventListener('click', (e) => {
    if (pressed) { pressed = false; return; }
    const r = e.target.closest('.nrow');
    if (!r) { clearSel(); return; }
    const it = byId(r.dataset.id);
    if (e.target.closest('.nmore')) {
      // On touch, ⋯ acts on just that item and leaves any selection alone.
      const touch = coarse.matches && e.pointerType !== 'mouse';
      if (touch && !N.sel.has(it.id)) return openMenu(actionsFor([it]), e.target.closest('.nmore'), it.name);
      if (!N.sel.has(it.id)) selectOnly(it.id);
      openMenu(actionsFor(selected()), e.target.closest('.nmore'), label(selected()));
      return;
    }
    if (coarse.matches && e.pointerType !== 'mouse') {
      if (N.sel.size) toggle(it.id); else activate(it, r);
    } else if (e.metaKey || e.ctrlKey) toggle(it.id);
    else if (e.shiftKey && N.anchor) selectRange(it.id);
    else selectOnly(it.id);
  });

  list.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.nrow');
    if (r && !e.target.closest('.nmore')) activate(byId(r.dataset.id), r);
  });

  list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.nrow');
    if (!r) return;
    e.preventDefault();
    if (coarse.matches && e.pointerType !== 'mouse') return; // long-press selects instead
    if (!N.sel.has(r.dataset.id)) selectOnly(r.dataset.id);
    openMenu(actionsFor(selected()), { x: e.clientX, y: e.clientY }, label(selected()));
  });

  function activate(it, rowEl) {
    if (N.mode === 'trash' || (it.kind === 'file' && coarse.matches)) {
      openMenu(actionsFor([it]), rowEl.querySelector('.nmore'), it.name);
    } else if (it.kind === 'folder') {
      location.hash = folderUrl(it.id);
    } else {
      download([it]);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (view.classList.contains('hidden') || dialog.open || !menu.classList.contains('hidden')) return;
    if (e.target.closest('input, select, textarea')) return;
    const items = selected();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      N.sel = new Set(N.items.map((i) => i.id));
      paintSelection();
    } else if (e.key === 'Escape' && N.sel.size) {
      clearSel();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && items.length) {
      e.preventDefault();
      if (N.mode === 'trash') deleteForever(items); else trash(items);
    } else if (e.key === 'F2' && items.length === 1 && N.mode === 'drive') {
      e.preventDefault();
      renameDialog(items[0]);
    } else if (e.key === 'Enter' && items.length === 1) {
      activate(items[0], list.querySelector(`[data-id="${CSS.escape(items[0].id)}"]`));
    }
  });

  // ---------- menus ----------

  const menu = el('div', { class: 'nmenu hidden', role: 'menu' });
  const scrim = el('div', { class: 'nscrim hidden' });
  document.body.append(scrim, menu);

  function actionsFor(items) {
    if (!items.length) return [];
    if (N.mode === 'trash') {
      return [
        { icon: 'restore', text: 'Restore', run: () => restore(items) },
        { icon: 'trash', text: 'Delete forever', run: () => deleteForever(items), danger: true },
      ];
    }
    const one = items.length === 1 ? items[0] : null;
    const files = items.every((i) => i.kind === 'file');
    return [
      one && one.kind === 'folder' && { icon: 'folder', text: 'Open', run: () => { location.hash = folderUrl(one.id); } },
      { icon: 'download', text: one && one.kind === 'file' ? 'Download' : 'Download as zip', run: () => download(items) },
      one && { icon: 'edit', text: 'Rename', run: () => renameDialog(one) },
      { icon: 'move', text: 'Move to…', run: () => moveDialog(items) },
      files && { icon: 'copy', text: items.length > 1 ? 'Make copies' : 'Make a copy', run: () => copy(items) },
      { icon: 'trash', text: 'Move to trash', run: () => trash(items), danger: true },
    ].filter(Boolean);
  }

  function openMenu(entries, at, title) {
    if (!entries.length) return;
    menu.replaceChildren(...[
      title ? el('div', { class: 'nmenu-title mono muted', text: title }) : null,
      ...entries.map((a) => el('button', {
        type: 'button',
        role: 'menuitem',
        class: a.danger ? 'danger' : '',
        onclick: () => { closeMenu(); a.run(); },
      }, ni(a.icon), el('span', { text: a.text }))),
    ].filter(Boolean));
    menu.classList.remove('hidden');
    scrim.classList.remove('hidden');
    // Phones get a sheet from the bottom (CSS); elsewhere it sits by the pointer.
    if (!matchMedia('(max-width: 600px)').matches) {
      const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      const x = Math.min(Math.max(8, (at instanceof Element ? r.right - w : r.left)), innerWidth - w - 8);
      const y = r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    } else {
      menu.style.left = menu.style.top = '';
    }
    menu.querySelector('button').focus({ preventScroll: true });
  }

  function closeMenu() {
    menu.classList.add('hidden');
    scrim.classList.add('hidden');
  }

  scrim.addEventListener('click', closeMenu);
  scrim.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMenu(); });
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
  });
  addEventListener('resize', closeMenu);

  // ---------- dialogs ----------

  const dialog = el('dialog', { class: 'card ndialog' });
  document.body.append(dialog);

  function showDialog(title, body, buttons) {
    dialog.replaceChildren(el('h3', { text: title }), ...body, el('div', { class: 'ndialog-buttons' }, ...buttons));
    dialog.showModal();
  }

  function ask({ title, value = '', ok = 'OK', selectStem = false }) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', value, maxlength: 240, 'aria-label': title, autocapitalize: 'off', spellcheck: 'false' });
      const form = el('form', { method: 'dialog' }, input);
      const done = (v) => { dialog.close(); resolve(v); };
      form.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); });
      showDialog(title, [form], [
        el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => done(null) }),
        el('button', { type: 'button', class: 'btn small', text: ok, onclick: () => form.requestSubmit() }),
      ]);
      dialog.onclose = () => resolve(null);
      input.focus();
      // Select the name without its extension, so typing replaces just the name.
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
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

  async function moveDialog(items) {
    const moving = new Set(items.map((i) => i.id));
    const startParent = N.mode === 'drive' ? N.folderId : 'root';
    let at = { id: 'root', name: 'My Drive', path: [] };
    const listBox = el('div', { class: 'nmove-list' });
    const where = el('div', { class: 'nmove-where mono muted' });
    const go = el('button', { type: 'button', class: 'btn small', text: 'Move here' });

    async function open(id) {
      listBox.replaceChildren(el('div', { class: 'muted nmove-note', text: 'Loading…' }));
      try {
        let folders = [];
        let d;
        do {
          d = await api('GET', `/api/nest/folders/${id}?folders=1&offset=${folders.length}`);
          folders = folders.concat(d.items);
        } while (d.more && folders.length < 2000);
        at = { id: d.folder.id, name: d.folder.name, path: d.path };
        const crumbs = [{ id: 'root', name: 'My Drive' }, ...d.path];
        where.replaceChildren(...crumbs.flatMap((c, i) => [
          i ? ni('chevron', 'crumb-sep') : null,
          i === crumbs.length - 1 ? el('b', { text: c.name }) : el('button', { type: 'button', class: 'link-btn mono', text: c.name, onclick: () => open(c.id) }),
        ]).filter(Boolean));
        const choices = folders.filter((f) => !moving.has(f.id));
        listBox.replaceChildren(...(choices.length
          ? choices.map((f) => el('button', { type: 'button', class: 'nmove-item', onclick: () => open(f.id) }, ni('folder'), el('span', { text: f.name }), ni('chevron')))
          : [el('div', { class: 'muted nmove-note', text: 'No folders in here' })]));
        go.disabled = at.id === startParent && items.every((i) => byId(i.id));
      } catch (err) {
        listBox.replaceChildren(el('div', { class: 'msg error', text: err.message }));
      }
    }

    go.addEventListener('click', async () => {
      dialog.close();
      await move(items, at.id, at.name);
    });
    showDialog(`Move ${label(items)}`, [where, listBox], [
      el('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => dialog.close() }),
      go,
    ]);
    dialog.onclose = null;
    await open(startParent);
  }

  // ---------- toast ----------

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
    N.items = N.items.filter((i) => !gone.has(i.id));
    N.total = Math.max(0, N.total - gone.size);
    for (const id of gone) N.sel.delete(id);
    render();
  }

  function download(items) {
    const one = items.length === 1 && items[0].kind === 'file';
    const a = el('a', { href: one ? `/api/nest/files/${items[0].id}` : `/api/nest/zip?ids=${items.map((i) => i.id).join(',')}`, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function newFolder() {
    const name = await ask({ title: 'New folder', value: 'Untitled folder', ok: 'Create' });
    if (!name) return;
    try {
      await api('POST', '/api/nest/folders', { parent: N.folderId, name });
      await load(N.items.length + 1);
    } catch (err) { toast(err.message); }
  }

  async function renameDialog(it) {
    const name = await ask({ title: 'Rename', value: it.name, ok: 'Rename', selectStem: it.kind === 'file' });
    if (!name || name === it.name) return;
    try {
      const old = it.name;
      const { item } = await api('PATCH', `/api/nest/items/${it.id}`, { name });
      await load(N.items.length);
      toast(`Renamed to “${item.name}”`, async () => {
        await api('PATCH', `/api/nest/items/${it.id}`, { name: old });
        await load(N.items.length);
      });
    } catch (err) { toast(err.message); }
  }

  async function move(items, parent, parentName) {
    try {
      const { moved } = await api('POST', '/api/nest/move', { ids: items.map((i) => i.id), parent });
      if (!moved.length) return;
      if (parent !== N.folderId) removeLocal(moved.map((m) => m.id)); else load(N.items.length);
      toast(`Moved ${label(moved)} to ${parentName}`, async () => {
        const back = new Map();
        for (const m of moved) back.set(m.from, [...(back.get(m.from) || []), m.id]);
        for (const [from, ids] of back) await api('POST', '/api/nest/move', { ids, parent: from });
        await load(N.items.length);
      });
    } catch (err) { toast(err.message); }
  }

  async function copy(items) {
    try {
      const { items: made } = await api('POST', '/api/nest/copy', { ids: items.map((i) => i.id) });
      await load(N.items.length + made.length);
      toast(made.length === 1 ? `Made “${made[0].name}”` : `Made ${made.length} copies`);
    } catch (err) { toast(err.message); }
  }

  async function trash(items) {
    const ids = items.map((i) => i.id);
    try {
      await api('POST', '/api/nest/trash', { ids });
      removeLocal(ids);
      toast(`${label(items)} moved to trash`, async () => {
        await api('POST', '/api/nest/restore', { ids });
        await load(N.items.length + ids.length);
      });
    } catch (err) { toast(err.message); }
  }

  async function restore(items) {
    try {
      const { restored } = await api('POST', '/api/nest/restore', { ids: items.map((i) => i.id) });
      removeLocal(restored.map((r) => r.id));
      toast(restored.length === 1 ? `Restored “${restored[0].name}”` : `Restored ${restored.length} items`);
    } catch (err) { toast(err.message); }
  }

  async function deleteForever(items) {
    const ok = await confirmBox({
      title: 'Delete forever?',
      text: `${label(items)} will be deleted forever. This can’t be undone.`,
      ok: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    try {
      const d = await api('POST', '/api/nest/trash/delete', { ids: items.map((i) => i.id) });
      N.storage = d.storage;
      removeLocal(d.deleted);
    } catch (err) { toast(err.message); }
  }

  $('#nest-empty-trash').addEventListener('click', async () => {
    const ok = await confirmBox({
      title: 'Empty trash?',
      text: `All ${plural(N.items.length, 'item')} in the trash will be deleted forever. This can’t be undone.`,
      ok: 'Empty trash',
      danger: true,
    });
    if (!ok) return;
    try {
      const d = await api('POST', '/api/nest/trash/delete', { all: true });
      N.storage = d.storage;
      removeLocal(d.deleted);
    } catch (err) { toast(err.message); }
  });

  // ---------- toolbar ----------

  const pickFiles = $('#nest-pick-files');
  const pickFolder = $('#nest-pick-folder');
  // Phones can't pick whole folders.
  const canPickFolder = 'webkitdirectory' in pickFolder && !coarse.matches;

  $('#nest-new').addEventListener('click', (e) => openMenu([
    { icon: 'folderPlus', text: 'New folder', run: newFolder },
    { icon: 'upload', text: 'Upload files', run: () => pickFiles.click() },
    canPickFolder && { icon: 'folder', text: 'Upload folder', run: () => pickFolder.click() },
  ].filter(Boolean), e.currentTarget));

  pickFiles.addEventListener('change', () => {
    queueUploads([...pickFiles.files].map((file) => ({ file, path: '' })), N.folderId, N.folder.name);
    pickFiles.value = '';
  });
  pickFolder.addEventListener('change', () => {
    queueUploads([...pickFolder.files].map((file) => ({
      file,
      path: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
    })), N.folderId, N.folder.name);
    pickFolder.value = '';
  });

  $('#nest-sort').addEventListener('change', (e) => sortBy(e.target.value));
  $('#nest-dir').addEventListener('click', () => sortBy(prefs.sort));
  document.querySelectorAll('[data-view-mode]').forEach((b) => b.addEventListener('click', () => {
    prefs.view = b.dataset.viewMode;
    savePrefs();
    renderTools();
    renderList();
  }));

  // ---------- drag and drop ----------

  const dropBox = $('#nest-drop');
  const main = $('#nest-main');
  let dragIds = null;
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const dropTarget = (e) => e.target.closest('[data-drop]');

  list.addEventListener('dragstart', (e) => {
    const r = e.target.closest('.nrow');
    if (!r) return;
    if (!N.sel.has(r.dataset.id)) selectOnly(r.dataset.id);
    dragIds = [...N.sel];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', selected().map((i) => i.name).join('\n'));
  });
  list.addEventListener('dragend', () => { dragIds = null; clearHover(); });

  function clearHover() {
    document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  }

  main.addEventListener('dragenter', (e) => {
    if (N.mode !== 'drive' || (!hasFiles(e) && !dragIds)) return;
    dragDepth++;
    if (hasFiles(e)) {
      $('#nest-drop-where').textContent = N.folder.name;
      dropBox.classList.remove('hidden');
    }
  });
  main.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropBox.classList.add('hidden'); clearHover(); }
  });
  view.addEventListener('dragover', (e) => {
    if (N.mode !== 'drive') return;
    const t = dropTarget(e);
    if (dragIds) {
      clearHover();
      if (t && !dragIds.includes(t.dataset.drop) && t.dataset.drop !== N.folderId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        t.classList.add('drop-hover');
      }
    } else if (hasFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      clearHover();
      if (t) t.classList.add('drop-hover');
      $('#nest-drop-where').textContent = t ? (byId(t.dataset.drop) || { name: t.textContent }).name : N.folder.name;
    }
  });
  view.addEventListener('drop', (e) => {
    if (N.mode !== 'drive') return;
    e.preventDefault();
    dragDepth = 0;
    dropBox.classList.add('hidden');
    clearHover();
    const t = dropTarget(e);
    const parent = t ? t.dataset.drop : N.folderId;
    const parentName = t ? (byId(parent) || { name: t.textContent }).name : N.folder.name;
    if (dragIds) {
      const items = dragIds.map(byId).filter(Boolean);
      dragIds = null;
      if (t && parent !== N.folderId) move(items, parent, parentName);
      return;
    }
    if (hasFiles(e)) filesFromDrop(e.dataTransfer).then(({ files, dirs }) => queueUploads(files, parent, parentName, dirs));
  });

  // Reads dropped files and folders. Entries must be taken before the first await.
  async function filesFromDrop(dt) {
    const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return { files: [...dt.files].map((file) => ({ file, path: '' })), dirs: [] };
    const files = [];
    const dirs = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        files.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path: prefix });
      } else if (entry.isDirectory) {
        const p = prefix ? `${prefix}/${entry.name}` : entry.name;
        dirs.push(p);
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, p);
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e, '');
    return { files, dirs };
  }

  // ---------- uploads ----------

  const UP = { tasks: [], running: 0, max: 3, collapsed: false };
  const panel = el('div', { class: 'card nup hidden', role: 'region', 'aria-label': 'Uploads' });
  document.body.append(panel);

  async function queueUploads(files, parent, parentName, dirs = []) {
    // Empty folders in a dropped folder still get made.
    const withFiles = new Set(files.flatMap((f) => f.path.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))));
    for (const d of dirs.filter((d) => !withFiles.has(d))) {
      await api('POST', '/api/nest/folders', { parent, path: d }).catch(() => {});
    }
    if (!files.length) { if (dirs.length) reloadSoon(); return; }
    for (const { file, path } of files) {
      UP.tasks.push({ file, path, parent, parentName, name: file.name, size: file.size, sent: 0, live: 0, state: 'queued' });
    }
    UP.collapsed = false;
    renderPanel();
    pump();
  }

  function pump() {
    while (UP.running < UP.max) {
      const t = UP.tasks.find((x) => x.state === 'queued');
      if (!t) break;
      UP.running++;
      runUpload(t).finally(() => { UP.running--; renderPanel(); pump(); tidySoon(); });
    }
  }

  // Once everything has uploaded without trouble, the panel gets out of the way.
  let tidyTimer = null;
  function tidySoon() {
    clearTimeout(tidyTimer);
    if (UP.tasks.some((t) => t.state !== 'done')) return;
    tidyTimer = setTimeout(() => {
      if (UP.tasks.some((t) => t.state !== 'done')) return;
      UP.tasks = [];
      renderPanel();
    }, 5000);
  }

  async function runUpload(t) {
    t.state = 'uploading';
    t.error = '';
    paintTask(t);
    try {
      if (!t.id) {
        const s = await api('POST', '/api/nest/uploads', { parent: t.parent, name: t.name, size: t.size, type: t.file.type, path: t.path });
        if (s.done) return finish(t);
        Object.assign(t, { id: s.id, chunk: s.chunkSize, sent: s.received });
      }
      while (t.sent < t.size) {
        if (t.state !== 'uploading') return;
        const r = await putChunk(t, t.file.slice(t.sent, Math.min(t.size, t.sent + t.chunk)));
        t.sent = r.received;
        t.live = t.sent;
        paintTask(t);
        if (r.done) return finish(t);
      }
    } catch (err) {
      if (t.state === 'cancelled') return;
      t.state = 'failed';
      t.error = err.message;
    }
  }

  function finish(t) {
    t.state = 'done';
    t.sent = t.live = t.size;
    if (N.mode === 'drive') reloadSoon();
  }

  function sendChunk(t, blob) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      t.xhr = x;
      x.open('PUT', `/api/nest/uploads/${t.id}?offset=${t.sent}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => { t.live = t.sent + e.loaded; paintTask(t); };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
        // 409 with a position: the server got a different amount, carry on from there.
        if (x.status === 200 || (x.status === 409 && Number.isInteger(d.received))) return resolve(d);
        const err = new Error(d.error || `Upload failed (${x.status})`);
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
        paintTask(t);
        await sleep(1000 * 2 ** Math.min(attempt, 4));
        t.error = '';
        // The server says where to carry on (with a 409) if some of the piece arrived.
      }
    }
  }

  function cancelTask(t) {
    const was = t.state;
    t.state = 'cancelled';
    if (t.xhr) t.xhr.abort();
    if (t.id && was === 'uploading') setTimeout(() => api('DELETE', `/api/nest/uploads/${t.id}`).catch(() => {}), 300);
    UP.tasks = UP.tasks.filter((x) => x !== t);
    renderPanel();
  }

  function taskStatus(t) {
    if (t.state === 'done') return 'Done';
    if (t.state === 'failed') return t.error || 'Failed';
    if (t.state === 'queued') return `Waiting · ${bytes(t.size)}`;
    if (t.error) return t.error;
    return `${bytes(t.live)} of ${bytes(t.size)}`;
  }

  function taskRow(t) {
    const pctDone = t.size ? (t.live / t.size) * 100 : 100;
    const actions = t.state === 'failed'
      ? el('button', { type: 'button', class: 'link-btn mono', text: 'Retry', onclick: () => { t.state = 'queued'; renderPanel(); pump(); } })
      : t.state === 'done'
        ? ni('check', 'nup-done')
        : el('button', { type: 'button', class: 'nup-x', 'aria-label': `Cancel ${t.name}`, onclick: () => cancelTask(t) }, ni('close'));
    t.row = el('div', { class: `nup-row ${t.state}` },
      ni(kindIcon({ kind: 'file', name: t.name, mime: t.file.type })),
      el('div', { class: 'nup-info' },
        el('div', { class: 'nup-name', text: t.name, title: t.name }),
        el('div', { class: 'meter' }, el('i', { style: `width:${pctDone}%` })),
        el('div', { class: 'nup-status mono muted', text: taskStatus(t) })),
      actions);
    return t.row;
  }

  let headTimer = null;
  function paintTask(t) {
    if (!t.row || !t.row.isConnected) return;
    t.row.querySelector('.meter i').style.width = `${t.size ? (t.live / t.size) * 100 : 100}%`;
    t.row.querySelector('.nup-status').textContent = taskStatus(t);
    if (!headTimer) headTimer = setTimeout(() => { headTimer = null; paintHead(); }, 250);
  }

  function paintHead() {
    const h = panel.querySelector('.nup-title');
    if (!h) return;
    const tasks = UP.tasks;
    const active = tasks.filter((t) => t.state === 'uploading' || t.state === 'queued');
    const failed = tasks.filter((t) => t.state === 'failed').length;
    if (active.length) {
      const total = tasks.reduce((a, t) => a + t.size, 0);
      const sent = tasks.reduce((a, t) => a + (t.state === 'done' ? t.size : t.live), 0);
      h.textContent = `Uploading ${plural(active.length, 'file')} · ${total ? Math.floor((sent / total) * 100) : 100}%`;
    } else {
      h.textContent = failed ? `${plural(failed, 'upload')} failed` : `${plural(tasks.length, 'upload')} complete`;
    }
  }

  function renderPanel() {
    document.body.classList.toggle('nup-open', UP.tasks.length > 0);
    document.body.classList.toggle('nup-collapsed', UP.collapsed);
    if (!UP.tasks.length) {
      panel.classList.add('hidden');
      return;
    }
    const busy = UP.tasks.some((t) => t.state === 'uploading' || t.state === 'queued');
    panel.replaceChildren(...[
      el('div', { class: 'nup-head' },
        el('b', { class: 'nup-title' }),
        el('button', { type: 'button', class: 'nup-x', 'aria-label': UP.collapsed ? 'Show uploads' : 'Hide uploads', onclick: () => { UP.collapsed = !UP.collapsed; renderPanel(); } }, ni(UP.collapsed ? 'up' : 'down')),
        busy ? null : el('button', { type: 'button', class: 'nup-x', 'aria-label': 'Close', onclick: () => { UP.tasks = []; renderPanel(); } }, ni('close'))),
      UP.collapsed ? null : el('div', { class: 'nup-list' }, ...UP.tasks.map(taskRow)),
    ].filter(Boolean));
    panel.classList.remove('hidden');
    paintHead();
  }

  addEventListener('beforeunload', (e) => {
    if (UP.tasks.some((t) => t.state === 'uploading' || t.state === 'queued')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}());
