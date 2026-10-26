// Roostflix: runs inside Jellyfin's page (added by Roost). Everything here is
// best effort; if any of it fails, Jellyfin simply looks like Jellyfin.
//  - keeps the tab title as Roostflix
//  - puts a hero carousel at the top of the home page: big backdrop, title,
//    synopsis and a Play button, cycling every 8 seconds, with a short muted
//    clip over the backdrop where it is cheap (see clipFor).
(() => {
  'use strict';
  const NAME = 'Roostflix';
  const ROTATE_MS = 8000;
  const CLIP_SECONDS = 15;
  const COUNT = 6;
  const CACHE_KEY = 'roostflix_hero';
  const CACHE_MS = 10 * 60 * 1000;
  const DIRECT = /^(mp4|m4v|mov)$/i;

  // ---------- tab title ----------
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

  // ---------- who is signed in ----------
  function session() {
    const c = window.ApiClient;
    if (c && c.accessToken && c.accessToken()) return { base: c.serverAddress().replace(/\/+$/, ''), token: c.accessToken(), userId: c.getCurrentUserId() };
    try {
      const s = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}').Servers[0];
      return { base: `${location.origin}/jellyfin`, token: s.AccessToken, userId: s.UserId };
    } catch { return null; }
  }

  const get = async (s, path) => {
    const res = await fetch(s.base + path, { headers: { Authorization: `MediaBrowser Client="Roostflix", Device="Browser", DeviceId="roostflix", Version="1", Token="${s.token}"` } });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  };

  // ---------- what to show ----------
  const safe = (v) => (typeof v === 'string' && /^[\w-]+$/.test(v) ? v : null);

  async function pick(s) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (hit && hit.user === s.userId && hit.until > Date.now()) return hit.items;
    } catch { /* no cache */ }
    const q = `Recursive=true&IncludeItemTypes=Movie,Series&SortBy=Random&Limit=24&ImageTypeLimit=1&EnableImageTypes=Backdrop,Logo&Fields=Overview,MediaSources,RemoteTrailers,LocalTrailerCount,RunTimeTicks`;
    const res = await get(s, `/Users/${s.userId}/Items?${q}`);
    const items = (res.Items || [])
      .filter((it) => safe(it.Id) && (it.BackdropImageTags || []).length && safe(it.BackdropImageTags[0]))
      .slice(0, COUNT)
      .map((it) => {
        const src = (it.MediaSources || [])[0] || {};
        const video = (src.MediaStreams || []).find((m) => m.Type === 'Video') || {};
        return {
          id: it.Id,
          name: String(it.Name || ''),
          overview: String(it.Overview || ''),
          year: it.ProductionYear || '',
          kind: it.Type,
          backdrop: it.BackdropImageTags[0],
          logo: (it.ImageTags || {}).Logo || null,
          localTrailers: it.LocalTrailerCount || 0,
          // Plays in the browser as it is only if no converting is needed.
          direct: it.Type === 'Movie' && DIRECT.test(src.Container || '') && /^h264$/i.test(video.Codec || '') && safe(src.Id) ? src.Id : null,
          ticks: it.RunTimeTicks || 0,
        };
      });
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ user: s.userId, until: Date.now() + CACHE_MS, items })); } catch { /* fine */ }
    return items;
  }

  // The cheapest clip there is for a title, or null (backdrop only):
  // a trailer in the library, else a stretch of the film itself if it plays
  // without converting. Never on phones, saved-data or slow connections.
  async function clipFor(s, it) {
    if (it.localTrailers) {
      try {
        const t = (await get(s, `/Users/${s.userId}/Items/${it.id}/LocalTrailers?Fields=MediaSources`))[0];
        const src = t && (t.MediaSources || [])[0];
        const v = src && (src.MediaStreams || []).find((m) => m.Type === 'Video');
        if (t && safe(t.Id) && src && DIRECT.test(src.Container || '') && v && /^h264$/i.test(v.Codec || '')) {
          return { url: `${s.base}/Videos/${t.Id}/stream?static=true&mediaSourceId=${src.Id}&api_key=${s.token}`, start: 0 };
        }
      } catch { /* fall through */ }
    }
    if (it.direct && it.ticks) {
      const secs = it.ticks / 1e7;
      return { url: `${s.base}/Videos/${it.id}/stream?static=true&mediaSourceId=${it.direct}&api_key=${s.token}`, start: Math.floor(secs * 0.2) };
    }
    return null;
  }

  const canPlayClips = () => {
    const c = navigator.connection || {};
    return matchMedia('(hover: hover) and (pointer: fine)').matches
      && !matchMedia('(prefers-reduced-motion: reduce)').matches
      && !c.saveData && (!c.effectiveType || c.effectiveType === '4g');
  };

  // ---------- the hero ----------
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let hero = null;

  function stop() {
    if (!hero) return;
    clearTimeout(hero.timer);
    hero.stopped = true;
    hero = null;
  }

  async function build(host) {
    const s = session();
    if (!s || !s.userId) return;
    let items;
    try { items = await pick(s); } catch { return; }
    if (!items.length || !host.isConnected) return;
    document.querySelectorAll('.rf-hero').forEach((e) => e.remove());

    const el = h('section', 'rf-hero');
    el.setAttribute('aria-roledescription', 'carousel');
    el.setAttribute('aria-label', 'Featured');
    const slides = items.map((it) => {
      const a = h('div', 'rf-slide');
      a.setAttribute('aria-hidden', 'true');
      const img = h('img', 'rf-back');
      img.alt = '';
      img.decoding = 'async';
      img.src = `${s.base}/Items/${it.id}/Images/Backdrop/0?maxWidth=1600&quality=70&tag=${it.backdrop}`;
      const shade = h('div', 'rf-shade');
      const body = h('div', 'rf-body');
      if (it.logo && safe(it.logo)) {
        const logo = h('img', 'rf-logo');
        logo.alt = it.name;
        logo.src = `${s.base}/Items/${it.id}/Images/Logo?maxWidth=600&tag=${it.logo}`;
        body.append(logo);
      } else {
        body.append(h('h2', 'rf-title', it.name));
      }
      body.append(h('p', 'rf-meta', [it.kind === 'Series' ? 'Series' : 'Film', it.year].filter(Boolean).join(' \u00B7 ')));
      body.append(h('p', 'rf-overview', it.overview));
      const play = h('a', 'rf-play', '\u25B6\u2002Play');
      play.href = `#/details?id=${it.id}`;
      body.append(play);
      a.append(img, shade, body);
      el.append(a);
      return a;
    });
    const dots = h('div', 'rf-dots');
    items.forEach((it, i) => {
      const d = h('button', 'rf-dot');
      d.type = 'button';
      d.setAttribute('aria-label', `Show ${it.name}`);
      d.addEventListener('click', () => show(i));
      dots.append(d);
    });
    el.append(dots);
    host.parentNode.insertBefore(el, host);

    stop();
    const state = { index: -1, timer: 0, paused: false, stopped: false, video: null };
    hero = state;
    const clips = canPlayClips();

    function endClip() {
      if (state.video) { state.video.remove(); state.video = null; }
    }

    async function startClip(i) {
      if (!clips || document.hidden) return;
      const clip = await clipFor(s, items[i]).catch(() => null);
      if (!clip || state.stopped || state.index !== i) return;
      const v = h('video', 'rf-clip');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.src = clip.url;
      v.addEventListener('loadedmetadata', () => { v.currentTime = clip.start; v.play().catch(() => endClip()); }, { once: true });
      // A short stretch only, then back to the picture.
      v.addEventListener('timeupdate', () => { if (v.currentTime >= clip.start + CLIP_SECONDS) endClip(); });
      v.addEventListener('playing', () => v.classList.add('rf-on'), { once: true });
      v.addEventListener('error', endClip, { once: true });
      slides[i].insertBefore(v, slides[i].querySelector('.rf-shade'));
      state.video = v;
    }

    function show(i) {
      clearTimeout(state.timer);
      endClip();
      state.index = (i + items.length) % items.length;
      slides.forEach((sl, n) => {
        sl.classList.toggle('rf-active', n === state.index);
        sl.setAttribute('aria-hidden', n === state.index ? 'false' : 'true');
        sl.querySelector('.rf-play').tabIndex = n === state.index ? 0 : -1;
      });
      [...dots.children].forEach((d, n) => d.classList.toggle('rf-current', n === state.index));
      // The next picture is fetched before it is needed.
      const next = slides[(state.index + 1) % slides.length].querySelector('.rf-back');
      if (next) next.loading = 'eager';
      startClip(state.index);
      schedule();
    }

    function schedule() {
      clearTimeout(state.timer);
      if (state.stopped || items.length < 2) return;
      state.timer = setTimeout(() => {
        // Not while hovered, hidden, or scrolled out of view.
        if (state.paused || document.hidden || !state.visible) return schedule();
        show(state.index + 1);
      }, ROTATE_MS);
    }

    el.addEventListener('mouseenter', () => { state.paused = true; });
    el.addEventListener('mouseleave', () => { state.paused = false; });
    el.addEventListener('focusin', () => { state.paused = true; });
    el.addEventListener('focusout', () => { state.paused = false; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') show(state.index + 1);
      if (e.key === 'ArrowLeft') show(state.index - 1);
    });
    // Swipe on phones.
    let x0 = null;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) show(state.index + (dx < 0 ? 1 : -1));
    }, { passive: true });
    new IntersectionObserver(([e]) => {
      state.visible = e.isIntersecting;
      if (state.video) { if (e.isIntersecting) state.video.play().catch(() => {}); else state.video.pause(); }
    }).observe(el);
    state.visible = true;
    document.addEventListener('visibilitychange', () => {
      if (state.video) { if (document.hidden) state.video.pause(); else state.video.play().catch(() => {}); }
    });

    show(0);
  }

  // ---------- when the home page shows ----------
  const homeHost = () => document.querySelector('.homePage:not(.hide) .homeSectionsContainer');
  let tries = 0;
  function mount() {
    const host = homeHost();
    if (!host) {
      // Jellyfin builds the page a moment after the route changes.
      if (tries++ < 20) setTimeout(mount, 250);
      return;
    }
    tries = 0;
    if (host.previousElementSibling && host.previousElementSibling.classList.contains('rf-hero')) return;
    build(host);
  }
  document.addEventListener('viewshow', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('homePage')) { tries = 0; mount(); } else stop();
  });
  document.addEventListener('viewbeforehide', stop);
  mount();

  // ---------- Request a movie ----------
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const roost = async (method, path, body) => {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  };
  const STATUS = { open: 'Waiting', added: 'Added', dismissed: 'Not now' };

  function openRequest() {
    if (document.querySelector('.rf-sheet')) return;
    const sheet = el('div', 'rf-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Request a movie');
    const box = el('form', 'rf-box');
    const input = el('input');
    input.placeholder = 'Movie or show title';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Title');
    const note = el('input');
    note.placeholder = 'Year or note (optional)';
    note.maxLength = 300;
    note.setAttribute('aria-label', 'Note');
    const msg = el('p', 'rf-msg');
    const row = el('div', 'rf-row');
    const send = el('button', 'rf-btn', 'Send');
    send.type = 'submit';
    const close = el('button', 'rf-btn rf-ghost', 'Close');
    close.type = 'button';
    row.append(send, close);
    const list = el('ul', 'rf-list');
    box.append(el('h2', '', 'Request a movie'), input, note, row, msg, list);
    sheet.append(box);
    document.body.append(sheet);
    const done = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') done(); };
    document.addEventListener('keydown', onKey);
    close.onclick = done;
    sheet.addEventListener('click', (e) => { if (e.target === sheet) done(); });
    const refresh = async () => {
      try {
        const { requests } = await roost('GET', '/api/roostflix/requests');
        list.replaceChildren(...requests.map((r) => { const li = el('li'); li.append(el('span', '', r.title), el('b', `rf-${r.status}`, STATUS[r.status] || r.status)); return li; }));
      } catch { /* the list is a bonus */ }
    };
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      send.disabled = true;
      try {
        await roost('POST', '/api/roostflix/requests', { title: input.value, note: note.value });
        input.value = note.value = '';
        msg.textContent = 'Sent. You’ll get a note when it’s added.';
        refresh();
      } catch (err) { msg.textContent = err.message; }
      send.disabled = false;
    });
    refresh();
    input.focus();
  }

  function mountRequestButton() {
    if (document.querySelector('.rf-request')) return;
    const host = document.querySelector('.headerRight') || document.querySelector('.skinHeader');
    if (!host) return;
    const b = el('button', 'rf-request', 'Request');
    b.type = 'button';
    b.title = 'Request a movie';
    b.onclick = openRequest;
    host.prepend(b);
  }

  // ---------- Save to Files ----------
  async function mountSave() {
    const page = document.querySelector('#itemDetailPage:not(.hide)');
    const m = /[?&]id=([\w-]+)/.exec(location.hash);
    const s = session();
    if (!page || !m || !s || !safe(m[1])) return;
    const bar = page.querySelector('.mainDetailButtons');
    if (!bar || bar.querySelector('.rf-save')) return;
    try {
      const it = await get(s, `/Users/${s.userId}/Items/${m[1]}?Fields=MediaSources`);
      if (!['Movie', 'Episode', 'Video'].includes(it.Type) || !(it.MediaSources || []).length || bar.querySelector('.rf-save')) return;
      const a = el('a', 'rf-save', 'Save to Files');
      a.href = `${s.base}/Items/${m[1]}/Download?api_key=${encodeURIComponent(s.token)}`;
      a.setAttribute('download', '');
      a.title = 'Download the original file to this device';
      bar.append(a);
    } catch { /* no button, nothing else changes */ }
  }

  const later = (fn) => { let n = 0; const t = () => { if (!fn() && n++ < 20) setTimeout(t, 250); }; t(); };
  const refreshExtras = () => { later(() => { mountRequestButton(); return document.querySelector('.rf-request'); }); mountSave(); };
  document.addEventListener('viewshow', refreshExtras);
  refreshExtras();

  // ---------- AirPlay: send H.264 ----------
  // Many TVs with built-in AirPlay take the sound of an HEVC film but not the
  // picture. While this page is casting, Jellyfin is told the player can't do
  // HEVC, so it converts the picture to H.264, then the film restarts where it was.
  let casting = false;
  const noHevc = (list) => String(list || '').split(',').map((c) => c.trim()).filter((c) => c && !/^(hevc|h265)$/i.test(c)).join(',');
  function plainProfile(profile) {
    const p = JSON.parse(JSON.stringify(profile));
    for (const key of ['DirectPlayProfiles', 'TranscodingProfiles']) {
      p[key] = (p[key] || []).filter((x) => x.Type !== 'Video' || x.VideoCodec === undefined || noHevc(x.VideoCodec) || !x.VideoCodec).map((x) => {
        if (x.Type === 'Video' && x.VideoCodec) x.VideoCodec = noHevc(x.VideoCodec);
        return x;
      });
    }
    return p;
  }
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (casting && init && typeof init.body === 'string' && /\/Items\/[\w-]+\/PlaybackInfo/.test(url)) {
        const body = JSON.parse(init.body);
        if (body && body.DeviceProfile) {
          body.DeviceProfile = plainProfile(body.DeviceProfile);
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch { /* leave the request as it was */ }
    return realFetch.call(this, input, init);
  };

  async function restartForCast(video) {
    const s = session();
    const c = window.ApiClient;
    if (!s || !c || !c.deviceId) return;
    try {
      const list = await get(s, `/Sessions?DeviceId=${encodeURIComponent(c.deviceId())}`);
      const now = (list.find((x) => x.NowPlayingItem) || {});
      if (!now.Id || !safe(now.NowPlayingItem.Id)) return;
      const ticks = Math.floor((video.currentTime || 0) * 1e7);
      await realFetch(`${s.base}/Sessions/${encodeURIComponent(now.Id)}/Playing?playCommand=PlayNow&itemIds=${now.NowPlayingItem.Id}&startPositionTicks=${ticks}`, {
        method: 'POST', headers: { Authorization: `MediaBrowser Client="Roostflix", Device="Browser", DeviceId="roostflix", Version="1", Token="${s.token}"` },
      });
    } catch { /* it keeps playing as it was */ }
  }

  document.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', (e) => {
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;
    const now = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
    if (now === casting) return;
    casting = now;
    restartForCast(video);
  }, true);
})();
