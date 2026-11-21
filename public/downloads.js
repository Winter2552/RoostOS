'use strict';

// Downloads: what Cockerel is fetching, with pause and cancel. The page asks
// Roost every few seconds only while it is open and the tab is visible.

(() => {
  const EVERY_MS = 4000;
  const S = { timer: null, key: '', busy: false };
  const GB = 1024 ** 3;
  const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);
  const speed = (b) => (b > 0 ? `${(b / 1048576).toFixed(1)} MB/s` : '0 MB/s');
  const left = (s) => (s <= 0 ? '' : s < 90 ? 'under a minute left' : s < 5400 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`);
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };

  async function act(action, id, btn) {
    if (action === 'cancel' && !confirm('Cancel this download and delete what has been downloaded so far?')) return;
    btn.disabled = true;
    try { await api('POST', '/api/downloads/control', { action, id }); } catch (err) { const n = $('#dl-note'); n.hidden = false; n.textContent = err.message; }
    load(true);
  }

  const button = (text, action, j) => el('button', { type: 'button', class: 'dl-btn', text, onclick: (e) => act(action, j.id, e.currentTarget) });

  function card(j) {
    const running = j.state === 'Downloading';
    const paused = j.state === 'Paused';
    const done = j.state === 'Added';
    const bad = j.state === 'Failed' || j.state === 'Cancelled';
    const pct = done ? 100 : Math.max(running || paused ? 2 : 0, j.progress || 0);
    const sub = [j.kind === 'show' ? 'show' : j.kind === 'movie' ? 'movie' : '', j.size ? size(j.size) : '', j.requester ? `for ${j.requester}` : ''].filter(Boolean).join(' · ');
    let line;
    if (running) line = [`${j.progress || 0}%`, speed(j.speed || 0), left(j.eta || 0), j.peers ? `${j.peers} peers` : ''].filter(Boolean).join(' · ');
    else if (paused) line = `Paused at ${j.progress || 0}%`;
    else if (done) line = `On Roostflix · ${ago(j.updatedAt || j.at)}`;
    else if (j.state === 'Cancelled') line = 'Cancelled';
    else if (j.state === 'Failed') line = 'Stopped. Retry to start it again.';
    else line = j.state;
    const buttons = running ? [button('Pause', 'pause', j), button('Cancel', 'cancel', j)]
      : paused ? [button('Resume', 'resume', j), button('Cancel', 'cancel', j)]
      : bad ? [button('Retry', 'retry', j), el('button', { type: 'button', class: 'dl-btn', text: 'Clear', onclick: async () => { try { await api('POST', '/api/cockerel/jobs/clear', { id: j.id }); } catch { /* shown next refresh */ } load(true); } })]
      : done ? [el('button', { type: 'button', class: 'dl-btn', text: 'Clear', onclick: async () => { try { await api('POST', '/api/cockerel/jobs/clear', { id: j.id }); } catch { /* shown next refresh */ } load(true); } })]
      : [];
    return el('div', { class: `dl-card${done ? ' done' : ''}${bad ? ' bad' : ''}` },
      el('div', { class: 'dl-top' }, el('div', {}, el('div', { class: 'dl-name', text: j.title || 'Download' }), el('div', { class: 'dl-sub mono', text: sub })), el('div', { class: 'dl-btns' }, ...buttons)),
      el('div', { class: 'dl-bar' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'dl-line mono', text: line }));
  }

  function stat(value, label) { return el('div', {}, el('b', { text: value }), el('span', { class: 'mono', text: label })); }

  async function load(force) {
    let d;
    try { d = await api('GET', '/api/downloads'); } catch (err) { const n = $('#dl-note'); n.hidden = false; n.textContent = err.message; return; }
    const key = JSON.stringify(d);
    if (key === S.key && !force) return;
    S.key = key;
    const note = $('#dl-note');
    note.hidden = !(d.paused || !d.enabled);
    note.textContent = !d.enabled ? 'Cockerel is not linked yet. Link him under Admin → Server → Cockerel.' : d.paused ? 'Cockerel is paused, so nothing new will start.' : '';
    $('#dl-stats').replaceChildren(stat(String(d.active), 'ACTIVE'), stat(speed(d.speed), 'SPEED'), stat(`${d.todayGb} GB`, `TODAY OF ${d.dayGb}`));
    const list = $('#dl-list');
    const going = d.jobs.filter((j) => !['Added', 'Failed', 'Cancelled'].includes(j.state));
    const past = d.jobs.filter((j) => ['Added', 'Failed', 'Cancelled'].includes(j.state));
    list.replaceChildren(
      ...(d.jobs.length ? [] : [el('div', { class: 'cx-empty' }, el('strong', { text: 'Nothing downloading' }), el('p', { text: 'Ask Cockerel for a film or paste a magnet link in the chat, and it shows up here.' }))]),
      ...going.map(card),
      ...(past.length ? [el('h3', { class: 'dl-h', text: 'Finished' }), ...past.map(card)] : []));
  }

  // The page refreshes only while it is shown and the tab is visible.
  function tick() {
    clearTimeout(S.timer);
    if (location.hash.replace(/^#\/?/, '').split('/')[0] !== 'downloads') return;
    if (!document.hidden) load(false);
    S.timer = setTimeout(tick, EVERY_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  window.downloadsOpen = () => {
    document.title = `Downloads · ${state.serverName}`;
    S.key = '';
    load(true);
    clearTimeout(S.timer);
    S.timer = setTimeout(tick, EVERY_MS);
  };
})();
