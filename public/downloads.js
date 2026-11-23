'use strict';

// Downloads: what Cockerel is fetching, with pause and cancel. The page asks
// Roost every few seconds only while it is open and the tab is visible.

(() => {
  const EVERY_MS = 4000;
  const S = { timer: null, key: '', busy: false, seen: null };
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
    const checking = j.state === 'Finding' || j.state === 'Requested';
    // Looking for the file list takes up to 3 minutes; much longer than that and it is stuck.
    const stuck = checking && Date.now() - Date.parse(j.updatedAt || j.at) > 5 * 60000;
    const waiting = j.state === 'Waiting';
    const bad = j.state === 'Failed' || j.state === 'Cancelled' || stuck;
    const pct = done ? 100 : Math.max(running || paused ? 2 : 0, j.progress || 0);
    const sub = [j.kind === 'show' ? 'show' : j.kind === 'movie' ? 'movie' : '', j.size ? size(j.size) : '', j.requester ? `for ${j.requester}` : ''].filter(Boolean).join(' · ');
    let line;
    if (running) line = [`${j.progress || 0}%`, speed(j.speed || 0), left(j.eta || 0), j.peers ? `${j.peers} peers` : ''].filter(Boolean).join(' · ');
    else if (paused) line = `Paused at ${j.progress || 0}%`;
    else if (done) line = `On Roostflix · ${ago(j.updatedAt || j.at)}`;
    else if (j.state === 'Cancelled') line = 'Cancelled';
    else if (stuck) line = 'Stuck: the torrent never answered. Retry, or clear it.';
    else if (j.state === 'Failed') line = j.note || 'Stopped. Retry to start it again.';
    else if (waiting) line = j.note || 'Needs your OK in the Cockerel chat';
    else if (checking) line = j.note || 'Checking the torrent…';
    else line = j.state;
    const buttons = running ? [button('Pause', 'pause', j), button('Cancel', 'cancel', j)]
      : paused ? [button('Resume', 'resume', j), button('Cancel', 'cancel', j)]
      : waiting ? [el('a', { class: 'dl-btn', href: '#/cockerel', text: 'Open chat' }), button('Cancel', 'cancel', j)]
      : checking && !stuck ? [button('Cancel', 'cancel', j)]
      : bad ? [button('Retry', 'retry', j), el('button', { type: 'button', class: 'dl-btn', text: 'Clear', onclick: async () => { try { await api('POST', '/api/cockerel/jobs/clear', { id: j.id }); } catch { /* shown next refresh */ } load(true); } })]
      : done ? [el('button', { type: 'button', class: 'dl-btn', text: 'Clear', onclick: async () => { try { await api('POST', '/api/cockerel/jobs/clear', { id: j.id }); } catch { /* shown next refresh */ } load(true); } })]
      : [];
    return el('div', { class: `dl-card${done ? ' done' : ''}${bad ? ' bad' : ''}${S.seen && !S.seen.has(j.id) ? ' dl-new' : ''}${checking && !stuck ? ' checking' : ''}`, 'data-id': j.id },
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
    const isStuck = (j) => (j.state === 'Finding' || j.state === 'Requested') && Date.now() - Date.parse(j.updatedAt || j.at) > 5 * 60000;
    const going = d.jobs.filter((j) => !['Added', 'Failed', 'Cancelled'].includes(j.state) && !isStuck(j));
    const past = d.jobs.filter((j) => ['Added', 'Failed', 'Cancelled'].includes(j.state) || isStuck(j));
    list.replaceChildren(
      ...(d.jobs.length ? [] : [el('div', { class: 'cx-empty' }, el('strong', { text: 'Nothing downloading' }), el('p', { text: 'Ask Cockerel for a film or paste a magnet link in the chat, and it shows up here.' }))]),
      ...going.map(card),
      ...(past.length ? [el('h3', { class: 'dl-h', text: 'Finished' }), ...past.map(card)] : []));
    S.seen = new Set(d.jobs.map((j) => j.id));
  }

  // The page refreshes only while it is shown and the tab is visible.
  function tick() {
    clearTimeout(S.timer);
    if (location.hash.replace(/^#\/?/, '').split('/')[0] !== 'downloads') return;
    if (!document.hidden) load(false);
    S.timer = setTimeout(tick, EVERY_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  // "Add a magnet": a small chip that opens into its own box, and closes after adding.
  let wired = false;
  function setOpen(open) {
    const box = $('#dl-addbox');
    box.classList.toggle('open', open);
    $('#dl-chip').setAttribute('aria-expanded', String(open));
    $('#dl-chip-text').textContent = open ? 'Add a magnet' : 'Add magnet';
    const form = $('#dl-add');
    if (open) { form.removeAttribute('inert'); setTimeout(() => $('#dl-link').focus(), 180); } else form.setAttribute('inert', '');
  }
  function wire() {
    if (wired) return;
    wired = true;
    document.querySelectorAll('.dl-seg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.dl-seg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    }));
    $('#dl-chip').addEventListener('click', () => setOpen(!$('#dl-addbox').classList.contains('open')));
    $('#dl-add').addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); $('#dl-chip').focus(); } });
    $('#dl-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = $('#dl-note');
      const go = $('#dl-go');
      go.disabled = true;
      try {
        await api('POST', '/api/downloads/add', { link: $('#dl-link').value.trim(), name: $('#dl-name').value, kind: (document.querySelector('.dl-seg .on') || {}).dataset.kind });
        $('#dl-link').value = '';
        $('#dl-name').value = '';
        setOpen(false);
        note.hidden = false;
        note.textContent = 'Added. It is being checked, and will appear below in a moment.';
        setTimeout(() => load(true), 2500);
      } catch (err) { note.hidden = false; note.textContent = err.message; }
      go.disabled = false;
    });
  }

  window.downloadsOpen = () => {
    wire();
    document.title = `Downloads · ${state.serverName}`;
    S.key = '';
    S.seen = null; // the first look shows everything as it is
    load(true);
    clearTimeout(S.timer);
    S.timer = setTimeout(tick, EVERY_MS);
  };
})();
