'use strict';

// One search box across the apps. Plain JS, no build step. Loaded after
// app.js and uses its helpers ($, el, api, state).
//
// Searches once typing pauses and at least two letters are in, cancels a
// search that is overtaken by more typing, and remembers recent answers for a
// few seconds so backspacing doesn't ask the server again. Results are grouped
// by app. Keys: / jumps to the box, ↓ ↑ move through results, Enter opens the
// first (or the chosen) one, Esc clears.

(function search() {
  const WAIT_MS = 200;
  const MIN_CHARS = 2;
  const CACHE_MS = 20 * 1000;

  const SI = {
    folder: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M3 10.5h18"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    image: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 2.5-2.5L20 17"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
    audio: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  };

  function kindIcon(it) {
    const m = it.mime || '';
    const name = it.kind === 'folder' ? 'folder'
      : m.startsWith('image/') ? 'image'
        : m.startsWith('video/') ? 'video'
          : m.startsWith('audio/') ? 'audio' : 'file';
    const s = el('span', { class: 'search-kind', 'aria-hidden': 'true' });
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${SI[name]}</svg>`;
    return s;
  }

  const box = $('#search');
  const input = $('#search-input');
  const out = $('#search-results');
  const cache = new Map();
  let timer = null;
  let pending = null;
  let shown = '';
  let owner = null;

  const clean = (v) => v.normalize('NFC').replace(/\s+/g, ' ').trim();
  const results = () => [...out.querySelectorAll('.search-hit')];

  // Called by app.js each time the app list loads.
  window.searchSetup = (searchable) => {
    box.classList.toggle('hidden', !searchable.length);
    const who = state.user && state.user.id;
    if (who !== owner) {
      owner = who;
      cache.clear();
      reset();
    }
  };

  function reset() {
    clearTimeout(timer);
    if (pending) pending.abort();
    pending = null;
    input.value = '';
    show('');
  }

  function show(q, nodes = []) {
    shown = q;
    out.replaceChildren(...nodes);
    out.classList.toggle('hidden', !nodes.length);
  }

  // The name with each typed word marked, built from text so names can't inject markup.
  function marked(name, words) {
    const lower = name.toLowerCase();
    const hits = new Array(name.length).fill(false);
    for (const w of words) {
      for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) hits.fill(true, i, i + w.length);
    }
    const span = el('span', { class: 'search-name' });
    let i = 0;
    while (i < name.length) {
      let j = i;
      while (j < name.length && hits[j] === hits[i]) j++;
      span.append(hits[i] ? el('mark', { text: name.slice(i, j) }) : name.slice(i, j));
      i = j;
    }
    return span;
  }

  function render(q, data) {
    const words = q.toLowerCase().split(' ');
    const groups = data.groups.filter((g) => g.items.length || g.error);
    if (!groups.some((g) => g.items.length)) {
      const notes = groups.filter((g) => g.error).map((g) => el('p', { class: 'search-note muted', text: g.error }));
      return show(q, [el('p', { class: 'search-empty', text: `Nothing matches “${q}”` }), ...notes]);
    }
    show(q, groups.map((g) => el('section', { class: 'search-group', 'aria-label': g.name },
      el('h3', { class: 'search-app mono muted', text: g.name }),
      g.error ? el('p', { class: 'search-note muted', text: g.error }) : null,
      el('ul', { class: 'search-list' }, g.items.map((it) => el('li', {},
        el('a', { class: 'search-hit', href: it.href, onclick: reset },
          kindIcon(it),
          el('span', { class: 'search-text' }, marked(it.name, words), it.detail ? el('span', { class: 'search-detail mono muted', text: it.detail }) : null))))),
      g.more ? el('p', { class: 'search-note muted', text: 'Showing the best matches. Add a word to narrow it down.' }) : null)));
  }

  async function run(q) {
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_MS) return render(q, hit.data);
    if (pending) pending.abort();
    const ctrl = new AbortController();
    pending = ctrl;
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`, null, ctrl.signal);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
      cache.set(q, { at: Date.now(), data });
      if (pending === ctrl && clean(input.value) === q) render(q, data);
    } catch (err) {
      if (err.name !== 'AbortError' && clean(input.value) === q) show(q, [el('p', { class: 'search-empty', text: err.message })]);
    } finally {
      if (pending === ctrl) pending = null;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = clean(input.value);
    if (q === shown) return;
    if (q.length < MIN_CHARS) {
      if (pending) pending.abort();
      return show('');
    }
    timer = setTimeout(() => run(q), WAIT_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) reset(); else input.blur();
    } else if (e.key === 'ArrowDown' && results().length) {
      e.preventDefault();
      results()[0].focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = clean(input.value);
      // Typed faster than the pause: search now; otherwise open the top result.
      if (q !== shown && q.length >= MIN_CHARS) { clearTimeout(timer); run(q); } else if (results().length) results()[0].click();
    }
  });

  out.addEventListener('keydown', (e) => {
    const list = results();
    const i = list.indexOf(document.activeElement);
    if (i === -1) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[i]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || input).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.focus(); }
  });

  // "/" jumps to the box from anywhere on the dashboard, unless you're typing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || box.classList.contains('hidden')) return;
    if (box.closest('.hidden') || e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    input.focus();
  });
})();
