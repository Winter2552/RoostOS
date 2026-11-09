// Roostflix player extras: runs inside Jellyfin's page (added by Roost).
// Everything is best effort; if any of it fails, Jellyfin's player simply
// behaves as it always did. Nothing runs in the background: the code wakes on
// the video's own events and on taps and keys, and does nothing otherwise.
//  - skip intro / recap / credits, from Jellyfin's Media Segments, or from
//    chapter names when no segments exist
//  - "Next episode" card 10 seconds into the credits (asks "Still watching?" after 3 in a row)
//  - chapter ticks and chapter names on the scrubber bar
//  - speed button, sleep timer, J/K/L, < > keys, double-tap to skip 10 seconds
//  - remembers audio and subtitle language per series
// It also shares a few helpers with skin.js through window.RF.
(() => {
  'use strict';

  const safe = (v) => (typeof v === 'string' && /^[\w-]+$/.test(v) ? v : null);

  // ---------- who is signed in, and a way to talk to Jellyfin ----------
  function session() {
    const c = window.ApiClient;
    if (c && c.accessToken && c.accessToken()) return { base: c.serverAddress().replace(/\/+$/, ''), token: c.accessToken(), userId: c.getCurrentUserId(), deviceId: c.deviceId ? c.deviceId() : null };
    try {
      const s = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}').Servers[0];
      return { base: `${location.origin}/jellyfin`, token: s.AccessToken, userId: s.UserId, deviceId: localStorage.getItem('_deviceId2') || null };
    } catch { return null; }
  }
  const auth = (s) => ({ Authorization: `MediaBrowser Client="Roostflix", Device="Browser", DeviceId="roostflix", Version="1", Token="${s.token}"` });
  async function call(method, path, body) {
    const s = session();
    if (!s) throw new Error('signed out');
    const res = await fetch(s.base + path, { method, headers: { ...auth(s), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(res.status);
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  // This browser's own Jellyfin session: what it is playing, and how to steer it.
  async function mySession() {
    const s = session();
    if (!s || !s.deviceId) return null;
    const list = await call('GET', `/Sessions?DeviceId=${encodeURIComponent(s.deviceId)}`);
    return (list || []).find((x) => x.DeviceId === s.deviceId) || null;
  }
  // Start an item in this browser's player, from a given point.
  // Jellyfin's remote command travels over its WebSocket, which never rides the
  // tunnel (stream.roostos.network): the server says OK and nothing happens. So
  // after sending it we watch for the video actually starting (no polling: the
  // video's own loadstart event) and, if it does not, open the item's page and
  // press its Play button like a person would.
  let loads = 0;
  document.addEventListener('loadstart', (e) => { if (isMainVideo(e.target)) loads++; }, true);
  function isMainVideo(v) { return v && v.tagName === 'VIDEO' && v.classList.contains('htmlvideoplayer'); }
  function pressPlay(id) {
    location.hash = `#/details?id=${id}`;
    let n = 0;
    const t = setInterval(() => {
      const b = [...document.querySelectorAll('.btnResume, .btnPlay')].find((x) => x.offsetParent && !x.classList.contains('hide') && !x.disabled);
      if (b) { clearInterval(t); b.click(); } else if (++n > 25) clearInterval(t);
    }, 300);
  }
  async function playNow(id, ticks) {
    if (!safe(id)) return false;
    const before = loads;
    let sent = false;
    try {
      const me = await mySession();
      if (me) {
        await call('POST', `/Sessions/${me.Id}/Playing?playCommand=PlayNow&itemIds=${id}&startPositionTicks=${Math.max(0, ticks | 0)}`);
        sent = true;
      }
    } catch { /* fall through to the page */ }
    if (sent) {
      await new Promise((r) => setTimeout(r, 3500));
      if (loads > before) return true;
    }
    pressPlay(id);
    return true;
  }
  window.RF = { session, call, safe, mySession, playNow };

  // ---------- small helpers ----------
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const isMain = (v) => v && v.tagName === 'VIDEO' && v.classList.contains('htmlvideoplayer');
  const ticks = (s) => Math.round(s * 1e7);
  const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } return null; };

  // ---------- one playback ----------
  let cur = null; // { video, id, item, segs, chapters, next, ... }
  let auto = false; // the next load was started by us (next episode)
  let sleep = null; // null | 30 | 60 | 'end'  (minutes, or end of episode)
  let sleepTimer = 0;
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  let speed = Number(store('rf_speed')) || 1;
  const streakGet = () => { try { return Number(sessionStorage.getItem('rf_streak')) || 0; } catch { return 0; } };
  const streakSet = (n) => { try { sessionStorage.setItem('rf_streak', String(n)); } catch { /* fine */ } };

  const CHAPTER_KIND = [
    [/^(intro|opening|title sequence|main title|op)\b/i, 'Intro'],
    [/recap|previously/i, 'Recap'],
    [/credits|outro|ending|\bend\b/i, 'Outro'],
  ];
  const LABEL = { Intro: 'Skip intro', Recap: 'Skip recap', Outro: 'Skip credits', Preview: 'Skip preview', Commercial: 'Skip' };

  function segmentsFromChapters(chapters, runTicks) {
    const out = [];
    chapters.forEach((c, i) => {
      const hit = CHAPTER_KIND.find(([re]) => re.test(c.Name || ''));
      if (!hit) return;
      const end = i + 1 < chapters.length ? chapters[i + 1].StartPositionTicks : runTicks;
      if (end > c.StartPositionTicks) out.push({ type: hit[1], start: c.StartPositionTicks / 1e7, end: end / 1e7 });
    });
    return out;
  }

  // Points drawn on the scrubber: the file's chapters, plus where intro, recap
  // and credits start and end (Intro Skipper stores those as segments, not
  // chapters, so a file with no chapters still gets marks).
  const SEG_NAME = { Intro: 'Intro', Recap: 'Recap', Outro: 'Credits', Preview: 'Preview', Commercial: 'Ad' };
  function scrubMarks(chapters, segs) {
    const marks = chapters.map((c) => ({ at: c.StartPositionTicks / 1e7, name: c.Name || '' }));
    const near = (t) => marks.some((m) => Math.abs(m.at - t) < 2);
    segs.forEach((g) => {
      if (g.start > 0 && !near(g.start)) marks.push({ at: g.start, name: SEG_NAME[g.type] || '' });
      if (g.end > 0 && !near(g.end)) marks.push({ at: g.end, name: '' });
    });
    return marks.sort((a, b) => a.at - b.at);
  }

  async function load(v) {
    // The id of what this browser is playing comes from its own session.
    let me = null;
    for (let n = 0; n < 5 && !me; n++) {
      try { const m = await mySession(); if (m && m.NowPlayingItem && safe(m.NowPlayingItem.Id)) me = m; } catch { return; }
      if (!me) await new Promise((r) => setTimeout(r, 1000));
      if (cur && cur.video !== v) return;
    }
    if (!me || !cur || cur.video !== v) return;
    const id = me.NowPlayingItem.Id;
    if (cur.id === id) return;
    cur.id = id;
    cur.sid = me.Id;
    const s = session();
    let item = null;
    try { item = await call('GET', `/Users/${s.userId}/Items/${id}?Fields=Chapters,MediaStreams,MediaSources,Trickplay`); } catch { /* no extras */ }
    if (!item || cur.id !== id) return;
    cur.item = item;
    cur.chapters = (item.Chapters || []).filter((c) => typeof c.StartPositionTicks === 'number');
    cur.segs = [];
    try {
      const r = await call('GET', `/MediaSegments/${id}`);
      cur.segs = ((r && r.Items) || []).filter((x) => LABEL[x.Type]).map((x) => ({ type: x.Type, start: x.StartTicks / 1e7, end: x.EndTicks / 1e7 }));
    } catch { /* this Jellyfin has no segments */ }
    if (!cur.segs.length) cur.segs = segmentsFromChapters(cur.chapters, item.RunTimeTicks || 0);
    cur.segs.sort((a, b) => a.start - b.start);
    cur.marks = scrubMarks(cur.chapters, cur.segs);
    // Next episode, if this is one.
    if (item.Type === 'Episode' && safe(item.SeriesId)) {
      try {
        const eps = (await call('GET', `/Shows/${item.SeriesId}/Episodes?UserId=${s.userId}&Fields=Overview`)).Items || [];
        const i = eps.findIndex((e) => e.Id === id);
        const n = i >= 0 ? eps[i + 1] : null;
        if (n && safe(n.Id)) cur.next = { id: n.Id, name: n.Name || '', label: `S${n.ParentIndexNumber || '?'}·E${n.IndexNumber || '?'}` };
      } catch { /* no next card */ }
    }
    // One Next episode box only: ours, so Jellyfin's own is hidden while ours is ready.
    document.documentElement.classList.toggle('rf-own-next', !!cur.next);
    mountScrubber();
    remember(true);
    // Start-from-where-you-were gets a 5 second run-up.
    if (item.UserData && item.UserData.PlaybackPositionTicks > ticks(30) && v.currentTime > 10 && !cur.rewound) {
      cur.rewound = true;
      v.currentTime = Math.max(0, v.currentTime - 5);
    }
    applyPrefs();
  }

  // ---------- audio and subtitles, per series ----------
  const prefKey = () => { const s = session(); return s ? `rf_prefs_${s.userId}` : null; };
  const langOf = (item, idx, type) => {
    const st = (item.MediaStreams || []).find((m) => m.Index === idx && m.Type === type);
    return st ? (st.Language || st.DisplayLanguage || '').toLowerCase() : null;
  };
  // Read what is selected now (cheap: one request) and keep it for the series.
  async function remember(applyOnly) {
    if (applyOnly || !cur || !cur.item || cur.item.Type !== 'Episode' || !safe(cur.item.SeriesId)) return;
    const k = prefKey();
    if (!k) return;
    try {
      const me = await mySession();
      const ps = me && me.PlayState;
      if (!ps || !me.NowPlayingItem || me.NowPlayingItem.Id !== cur.id) return;
      const all = store(k) || {};
      const a = ps.AudioStreamIndex != null ? langOf(cur.item, ps.AudioStreamIndex, 'Audio') : null;
      const sub = ps.SubtitleStreamIndex != null && ps.SubtitleStreamIndex >= 0 ? langOf(cur.item, ps.SubtitleStreamIndex, 'Subtitle') : '';
      all[cur.item.SeriesId] = { a, s: sub };
      store(k, all);
    } catch { /* fine */ }
  }
  async function applyPrefs() {
    const k = prefKey();
    if (!k || !cur || !cur.item || cur.item.Type !== 'Episode') return;
    const want = (store(k) || {})[cur.item.SeriesId];
    if (!want) return;
    const streams = cur.item.MediaStreams || [];
    try {
      const me = await mySession();
      const ps = (me && me.PlayState) || {};
      const cmd = (Name, Index) => call('POST', `/Sessions/${cur.sid}/Command`, { Name, Arguments: { Index: String(Index) } });
      if (want.a) {
        const t = streams.find((m) => m.Type === 'Audio' && (m.Language || '').toLowerCase() === want.a);
        if (t && t.Index !== ps.AudioStreamIndex) await cmd('SetAudioStreamIndex', t.Index);
      }
      if (want.s === '') {
        if (ps.SubtitleStreamIndex != null && ps.SubtitleStreamIndex >= 0) await cmd('SetSubtitleStreamIndex', -1);
      } else if (want.s) {
        const subs = streams.filter((m) => m.Type === 'Subtitle' && (m.Language || '').toLowerCase() === want.s);
        const t = subs.find((m) => !m.IsForced) || subs[0];
        if (t && t.Index !== ps.SubtitleStreamIndex) await cmd('SetSubtitleStreamIndex', t.Index);
      }
    } catch { /* fine */ }
  }

  // ---------- the skip pill and the next episode card ----------
  const skip = h('button', 'rf-skip');
  skip.type = 'button';
  skip.hidden = true;
  const card = h('div', 'rf-next');
  card.hidden = true;
  const cardTitle = h('div', 'rf-next-title');
  const cardName = h('div', 'rf-next-name');
  const cardGo = h('button', 'rf-next-go', 'Play now');
  cardGo.type = 'button';
  const cardNo = h('button', 'rf-next-no', 'Cancel');
  cardNo.type = 'button';
  const cardRow = h('div', 'rf-next-row');
  cardRow.append(cardGo, cardNo);
  card.append(cardTitle, cardName, cardRow);
  let cardTimer = 0;
  let cardLeft = 0;

  function mountUi() {
    const host = document.body;
    if (!skip.isConnected) host.append(skip, card);
  }
  function hideCard(cancelled) {
    clearInterval(cardTimer);
    cardTimer = 0;
    card.hidden = true;
    if (cur && cancelled) cur.cancelled = true;
  }
  function goNext() {
    if (!cur || !cur.next) return;
    const id = cur.next.id;
    hideCard(false);
    auto = true;
    streakSet(streakGet() + 1);
    remember();
    // If our own route fails (no session found, API refused), never fail silently:
    // press Jellyfin's own next button, and as a last resort open the episode page.
    playNow(id, 0).then((ok) => { if (!ok) throw new Error('no session'); }).catch(() => {
      auto = false;
      const nb = document.querySelector('.btnNextItem, .btnNextTrack, .btnNext');
      if (nb && !nb.disabled) nb.click();
      else location.hash = `#/details?id=${id}`;
    });
  }
  function showCard() {
    if (!cur || !cur.next || cur.cancelled || !card.hidden || sleep === 'end') return;
    const asking = streakGet() >= 3;
    cardTitle.textContent = asking ? 'Still watching?' : 'Next episode';
    cardName.textContent = `${cur.next.label}  ${cur.next.name}`;
    card.hidden = false;
    cardGo.textContent = asking ? 'Keep watching' : 'Play now';
    if (asking) return;
    cardLeft = 10;
    cardNo.textContent = `Cancel (${cardLeft})`;
    clearInterval(cardTimer);
    cardTimer = setInterval(() => {
      cardLeft -= 1;
      if (cardLeft <= 0) return goNext();
      cardNo.textContent = `Cancel (${cardLeft})`;
    }, 1000);
  }
  cardGo.addEventListener('click', () => { streakSet(0); goNext(); });
  cardNo.addEventListener('click', () => hideCard(true));
  skip.addEventListener('click', () => {
    if (!cur || !cur.video || !skip.dataset.to) return;
    const to = Number(skip.dataset.to);
    if (cur.next && skip.dataset.type === 'Outro') return goNext();
    cur.video.currentTime = to + 0.3;
    skip.hidden = true;
  });

  function tick(v) {
    if (!cur || cur.video !== v || !cur.segs) return;
    const t = v.currentTime;
    const dur = v.duration || 0;
    if (sleep === 'end' && dur && dur - t < 1.5) { v.pause(); sleep = null; paintCtl(); return; }
    const seg = cur.segs.find((x) => t >= x.start - 0.5 && t < x.end - 1.5);
    if (seg && !(seg.type === 'Outro' && cur.next)) {
      skip.textContent = LABEL[seg.type];
      skip.dataset.to = String(seg.end);
      skip.dataset.type = seg.type;
      skip.hidden = false;
    } else skip.hidden = true;
    // The card starts 10 seconds into the credits, or in the last 40 seconds when there are none.
    const outro = cur.segs.find((x) => x.type === 'Outro');
    const cardAt = outro ? outro.start + 10 : 0;
    const nearEnd = dur > 600 && dur - t <= 40;
    if (cur.next && ((outro && t >= cardAt) || nearEnd)) showCard();
    else if (!card.hidden && cur.next && t < (outro ? cardAt : dur - 40) - 2) hideCard(false);
  }

  // ---------- chapters on the scrubber ----------
  const tip = h('div', 'rf-chaptip');
  tip.hidden = true;
  const thumb = h('div', 'rf-thumb');
  thumb.hidden = true;
  const tipText = h('span', 'rf-chaptext');
  tip.append(thumb, tipText);
  const clock = (t) => {
    const x = Math.max(0, Math.floor(t));
    const m = Math.floor(x / 60);
    const sec = String(x % 60).padStart(2, '0');
    return x >= 3600 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  // Jellyfin's hover pictures ("trickplay"): sheets of small frames. Only there
  // when the library has trickplay generation on; if not, we show the name only.
  function trickplayFor(item) {
    try {
      const src = (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].Id) || item.Id;
      const sets = (item.Trickplay && (item.Trickplay[src] || Object.values(item.Trickplay)[0])) || null;
      if (!sets || !safe(src)) return null;
      const widths = Object.keys(sets).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      const w = widths.find((n) => n >= 240) || widths[widths.length - 1];
      const info = w && sets[w];
      if (!info || !info.Interval || !info.TileWidth || !info.TileHeight || !info.Width || !info.Height) return null;
      return { src, w, info };
    } catch { return null; }
  }
  function paintThumb(tp, at) {
    const s = session();
    if (!tp || !s || !safe(cur.id)) { thumb.hidden = true; return; }
    const { info } = tp;
    const per = info.TileWidth * info.TileHeight;
    const count = info.ThumbnailCount || Infinity;
    const idx = Math.min(count - 1, Math.max(0, Math.floor((at * 1000) / info.Interval)));
    const sheet = Math.floor(idx / per);
    const inSheet = idx % per;
    const url = `${s.base}/Videos/${cur.id}/Trickplay/${tp.w}/${sheet}.jpg?MediaSourceId=${tp.src}&api_key=${encodeURIComponent(s.token)}`;
    thumb.style.width = `${info.Width}px`;
    thumb.style.height = `${info.Height}px`;
    thumb.style.backgroundImage = `url("${url}")`;
    thumb.style.backgroundSize = `${info.Width * info.TileWidth}px ${info.Height * info.TileHeight}px`;
    thumb.style.backgroundPosition = `-${(inSheet % info.TileWidth) * info.Width}px -${Math.floor(inSheet / info.TileWidth) * info.Height}px`;
    thumb.hidden = false;
  }
  function mountScrubber() {
    let n = 0;
    const go = () => {
      const slider = document.querySelector('.osdPositionSlider');
      const box = slider && slider.parentElement;
      if (!box || !cur || !cur.marks || !cur.item) { if (n++ < 20) setTimeout(go, 500); return; }
      box.querySelectorAll('.rf-ticks').forEach((e) => e.remove());
      const run = cur.item.RunTimeTicks || 0;
      const runS = run / 1e7;
      if (!run) return;
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      const wrap = h('div', 'rf-ticks');
      cur.marks.forEach((m) => {
        if (m.at <= 0) return;
        const t = h('i');
        t.style.left = `${(m.at / runS) * 100}%`;
        wrap.append(t);
      });
      box.append(wrap, tip);
      if (!slider.dataset.rf) {
        slider.dataset.rf = '1';
        const at = (e) => {
          if (!cur || !cur.marks) return;
          const r = slider.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          const at = f * runS;
          let name = '';
          cur.marks.forEach((m) => { if (m.at <= at) name = m.name; });
          const tp = cur.trickplay === undefined ? (cur.trickplay = trickplayFor(cur.item)) : cur.trickplay;
          paintThumb(tp, at);
          tipText.textContent = tp ? (name ? `${clock(at)} · ${name}` : clock(at)) : name;
          tip.hidden = !tp && !name;
          // keep the picture on screen at both ends of the bar
          const half = (tip.offsetWidth || 0) / 2;
          const b = box.getBoundingClientRect();
          const px = Math.min(b.width, Math.max(0, e.clientX - b.left));
          tip.style.left = `${half ? Math.min(Math.max(px, half), b.width - half) : px}px`;
        };
        slider.addEventListener('pointermove', at);
        slider.addEventListener('pointerleave', () => { tip.hidden = true; });
      }
    };
    go();
  }

  // ---------- speed, sleep timer ----------
  const ctl = h('div', 'rf-ctl');
  const speedBtn = h('button', 'rf-ctl-btn');
  speedBtn.type = 'button';
  speedBtn.setAttribute('aria-label', 'Playback speed');
  const sleepBtn = h('button', 'rf-ctl-btn');
  sleepBtn.type = 'button';
  sleepBtn.setAttribute('aria-label', 'Sleep timer');
  ctl.append(speedBtn, sleepBtn);
  const paintCtl = () => {
    speedBtn.textContent = `${speed}×`;
    sleepBtn.textContent = sleep === 'end' ? '☾ End' : sleep ? `☾ ${sleep}m` : '☾';
  };
  paintCtl();
  function setSpeed(x) {
    speed = x;
    store('rf_speed', x);
    if (cur && cur.video) cur.video.playbackRate = x;
    paintCtl();
  }
  speedBtn.addEventListener('click', () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] || 1));
  sleepBtn.addEventListener('click', () => {
    sleep = sleep === null ? 30 : sleep === 30 ? 60 : sleep === 60 ? 'end' : null;
    clearTimeout(sleepTimer);
    if (typeof sleep === 'number') {
      sleepTimer = setTimeout(() => { if (cur && cur.video) cur.video.pause(); sleep = null; paintCtl(); }, sleep * 60000);
    }
    paintCtl();
  });
  let hideCtl = 0;
  function wake() {
    if (!cur || !cur.video || !cur.video.isConnected) { ctl.classList.remove('rf-show'); return; }
    ctl.classList.add('rf-show');
    clearTimeout(hideCtl);
    hideCtl = setTimeout(() => ctl.classList.remove('rf-show'), 3500);
  }
  ['pointermove', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, wake, { passive: true }));

  // ---------- keys and double-tap ----------
  document.addEventListener('keydown', (e) => {
    if (!cur || !cur.video || !cur.video.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable) return;
    const v = cur.video;
    if (e.key === 'j' || e.key === 'J') v.currentTime = Math.max(0, v.currentTime - 10);
    else if (e.key === 'l' || e.key === 'L') v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10);
    else if (e.key === 'k' || e.key === 'K') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (e.key === '>') setSpeed(Math.min(2, Math.round((speed + 0.25) * 100) / 100));
    else if (e.key === '<') setSpeed(Math.max(0.5, Math.round((speed - 0.25) * 100) / 100));
    else return;
    e.preventDefault();
  });
  let lastTap = 0;
  document.addEventListener('touchend', (e) => {
    if (!cur || !cur.video || !cur.video.isConnected || e.target.closest('button, a, .videoOsdBottom, .osdControls, .rf-ctl')) return;
    const x = e.changedTouches[0].clientX;
    const w = window.innerWidth;
    if (x > w * 0.35 && x < w * 0.65) { lastTap = 0; return; }
    const now = Date.now();
    if (now - lastTap < 320) {
      cur.video.currentTime = Math.max(0, cur.video.currentTime + (x < w / 2 ? -10 : 10));
      lastTap = 0;
    } else lastTap = now;
  }, { passive: true });

  // ---------- the video's own events ----------
  document.addEventListener('loadstart', (e) => {
    if (!isMain(e.target)) return;
    clearInterval(cardTimer);
    card.hidden = true;
    skip.hidden = true;
    if (!auto) streakSet(0);
    auto = false;
    document.documentElement.classList.remove('rf-own-next');
    cur = { video: e.target, id: null, segs: [], chapters: [] };
    e.target.playbackRate = speed;
    mountUi();
    if (!ctl.isConnected) document.body.append(ctl);
  }, true);
  document.addEventListener('playing', (e) => {
    if (!isMain(e.target)) return;
    if (!cur || cur.video !== e.target) cur = { video: e.target, id: null, segs: [], chapters: [] };
    e.target.playbackRate = speed;
    mountUi();
    if (!ctl.isConnected) document.body.append(ctl);
    if (!cur.id && !cur.loading) { cur.loading = true; load(e.target).finally(() => { if (cur) cur.loading = false; }); }
  }, true);
  document.addEventListener('timeupdate', (e) => { if (isMain(e.target)) tick(e.target); }, true);
  document.addEventListener('pause', (e) => { if (isMain(e.target)) remember(); }, true);
  document.addEventListener('ended', (e) => {
    if (!isMain(e.target)) return;
    if (sleep === 'end') { sleep = null; paintCtl(); return; }
  }, true);
  // Leaving the player clears everything away.
  document.addEventListener('viewbeforehide', () => {
    if (cur && cur.video && !cur.video.isConnected) { document.documentElement.classList.remove('rf-own-next'); remember(); cur = null; skip.hidden = true; hideCard(false); ctl.classList.remove('rf-show'); }
  });
})();
