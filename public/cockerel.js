'use strict';

// Cockerel: chat with your agent and watch what he is doing. The page only
// refreshes while it is open and visible; when you leave it, nothing runs.

(() => {
  const REFRESH_MS = 6000;
  const S = { built: false, timer: null, busy: false, steps: false, last: '', open: false, d: null, seen: null, typing: false, again: false };
  const STAGES = ['Requested', 'Finding', 'Downloading', 'Added'];
  const IDEAS = ["What's new on Roostflix?", 'Any alerts today?', 'Find a film for me'];

  // His mark: the Roost bird with a comb, a two-part beak and a wattle. The
  // beak and a small bob are what animate when he speaks (see style.css).
  const MARK = '<svg class="cx-mark" viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(-4 -3)"><g class="cx-bird"><path d="M14 54V26h16a18 18 0 0 1 18 18v10z" fill="currentColor"/><circle cx="19" cy="23" r="4.2" fill="currentColor"/><circle cx="26" cy="20.5" r="5" fill="currentColor"/><circle cx="33" cy="23" r="4.2" fill="currentColor"/><rect x="14" y="22" width="19" height="6"/><path class="cx-beak-up" d="M47 36l11 3.5-11 2.5z" fill="currentColor"/><path class="cx-beak-low" d="M47 43l9 3-9 2.5z" fill="currentColor"/><circle cx="50.5" cy="50.5" r="2.6" fill="currentColor"/><circle class="cx-eye" cx="37" cy="35" r="3" fill="var(--bg)"/></g></g></svg>';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function avatar(cls = '') {
    const a = el('span', { class: `cx-avatar ${cls}`.trim() });
    a.innerHTML = MARK; // code-check: ok (Roost's own mark, fixed markup)
    return a;
  }

  const when = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // One word for how he is, one dot for the colour.
  function health(d) {
    if (!d.enabled) return { dot: 'off', text: 'Not linked yet', more: 'Link him under Admin → Server → Cockerel.' };
    if (d.paused) return { dot: 'off', text: 'Paused', more: 'He is not listening and will not start anything new.' };
    const s = d.status || {};
    if (!s.reachable) return { dot: 'bad', text: 'Not answering', more: "Check that his VM is running." };
    if (s.vpn === 'down') return { dot: 'bad', text: 'VPN is down', more: 'Downloads are stopped until it is back.' };
    const bits = [];
    if (s.vpn === 'up') bits.push('VPN on');
    if (Number.isFinite(s.cpu)) bits.push(`CPU ${s.cpu}%`);
    if (Number.isFinite(s.memMb)) bits.push(`RAM ${Math.round(s.memMb)} MB`);
    if (Number.isFinite(s.diskPct)) bits.push(`disk ${s.diskPct}%`);
    bits.push(`${d.todayGb} of ${d.dayGb} GB downloaded today`);
    return { dot: s.busy ? 'busy' : 'ok', text: s.busy ? 'Working…' : 'Online', more: bits.join(' · ') };
  }

  function job(j) {
    const at = STAGES.indexOf(j.state);
    const failed = j.state === 'Failed';
    const pct = failed ? 100 : Math.round(((at + (j.state === 'Downloading' && j.progress ? j.progress / 100 : 0.5)) / STAGES.length) * 100);
    return el('div', { class: `cx-job${failed ? ' failed' : ''}${j.state === 'Added' ? ' done' : ''}` },
      el('span', { class: 'cx-job-name', text: j.title || 'Job' }),
      el('span', { class: 'cx-job-state', text: failed ? 'Failed' : j.state }),
      el('span', { class: 'cx-track' }, el('i', { style: `width:${j.state === 'Added' ? 100 : pct}%` })));
  }

  // His words appear as if he is saying them, with his beak moving. Only for a
  // reply that arrives while the page is open; history shows straight away.
  function speak(row, text) {
    const p = row.querySelector('p');
    const bird = row.querySelector('.cx-avatar');
    if (reduceMotion.matches || !p) return;
    const step = Math.max(1, Math.ceil(text.length / 70));
    let n = 0;
    p.textContent = '';
    S.typing = true;
    bird.classList.add('speaking');
    const tickText = () => {
      n = Math.min(text.length, n + step);
      p.textContent = text.slice(0, n);
      const feed = $('#cx-feed');
      feed.scrollTop = feed.scrollHeight;
      if (n < text.length && !$('#view-cockerel').classList.contains('hidden')) return setTimeout(tickText, 22);
      p.textContent = text;
      bird.classList.remove('speaking');
      S.typing = false;
      if (S.again) { S.again = false; load({ force: true }); }
    };
    tickText();
  }

  function entry(e, answer, first, fresh) {
    if (e.kind === 'you') return el('div', { class: 'cx-msg you', title: when(e.at) }, el('p', { text: e.text }));
    if (e.kind === 'cockerel') {
      const row = el('div', { class: 'cx-row', title: when(e.at) }, first ? avatar() : el('span', { class: 'cx-avatar gap' }), el('div', { class: 'cx-msg cockerel' }, el('p', { text: e.text })));
      if (fresh) requestAnimationFrame(() => speak(row, e.text));
      return row;
    }
    if (e.kind === 'ask') {
      return el('div', { class: `cx-ask${e.answer ? ' answered' : ''}` }, el('p', { text: e.text }),
        e.answer ? el('span', { class: 'cx-answered', text: `You chose: ${e.answer}` })
          : el('div', { class: 'cx-choices' }, e.options.map((o, i) => el('button', { class: `cx-choice${i ? '' : ' primary'}`, type: 'button', text: o, onclick: (ev) => { ev.currentTarget.parentNode.querySelectorAll('button').forEach((b) => { b.disabled = true; }); answer(e, o); } }))));
    }
    return el('div', { class: 'cx-step' }, el('time', { text: when(e.at) }), el('span', { text: e.text }));
  }

  function empty(d) {
    if (!d.enabled) return el('div', { class: 'cx-empty' }, el('strong', { text: 'Cockerel is not linked yet' }), el('p', { text: 'Set up his VM, then link him under Admin → Server → Cockerel.' }));
    return el('div', { class: 'cx-empty' }, el('strong', { text: 'What can I do for you?' }), el('p', { text: 'Ask me to check Roostflix, explain an alert, or find an open-licensed film.' }),
      el('div', { class: 'cx-ideas' }, IDEAS.map((t) => el('button', { type: 'button', class: 'cx-idea', text: t, onclick: () => send(t) }))));
  }

  async function load(opts = {}) {
    let d;
    try { d = await api('GET', '/api/cockerel'); } catch (err) { $('#cx-state').textContent = err.message; $('#cx-dot').className = 'cx-dot bad'; return; }
    S.d = d;
    const h = health(d);
    $('#cx-state').textContent = h.text;
    $('#cx-dot').className = `cx-dot ${h.dot}`;
    $('#cx-logo').classList.toggle('speaking', S.busy || Boolean(d.status && d.status.busy));
    $('#cx-more').textContent = h.more;
    $('#cx-pause').textContent = d.paused ? 'Resume' : 'Pause';
    $('#cx-pause').hidden = !d.enabled;
    $('#cx-form').hidden = !d.enabled || d.paused;
    const key = JSON.stringify([d.log.slice(-1), d.log.length, d.jobs, d.paused, d.enabled, S.steps]);
    if (key === S.last && !opts.force) return;
    if (S.typing) { S.again = true; return; } // let him finish the sentence
    S.last = key;
    const jobs = $('#cx-jobs');
    const live = d.jobs.filter((j) => j.state !== 'Added' || Date.now() - Date.parse(j.updatedAt || j.at) < 3600e3).slice(0, 4);
    jobs.replaceChildren(...live.map(job));
    jobs.hidden = !live.length;
    const feed = $('#cx-feed');
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const shown = d.log.filter((e) => S.steps || (e.kind !== 'note' && e.kind !== 'event'));
    // The first look at the page shows history as it is; later replies are spoken.
    const known = S.seen;
    S.seen = new Set(d.log.map((e) => e.id));
    let prev = null;
    feed.replaceChildren(...(shown.length ? shown.map((e) => {
      const node = entry(e, answer, !prev || prev.kind !== 'cockerel', known && !known.has(e.id) && e.kind === 'cockerel');
      prev = e;
      return node;
    }) : [empty(d)]));
    if (stick || opts.force) feed.scrollTop = feed.scrollHeight;
  }

  async function answer(e, choice) {
    try { await api('POST', '/api/cockerel/answer', { id: e.id, choice }); } catch (err) { $('#cx-more').hidden = false; $('#cx-more').textContent = err.message; }
    load({ force: true });
  }

  async function send(text) {
    text = String(text || '').trim();
    if (S.busy || !text) return;
    S.busy = true;
    $('#cx-text').value = '';
    $('#cx-send').disabled = true;
    $('#cx-typing').hidden = false;
    $('#cx-logo').classList.add('speaking');
    // His reply arrives when he finishes; the message shows straight away.
    const sent = api('POST', '/api/cockerel/chat', { text });
    setTimeout(() => load({ force: true }), 250);
    try { await sent; } catch (err) { $('#cx-more').hidden = false; $('#cx-more').textContent = err.message; }
    S.busy = false;
    $('#cx-send').disabled = false;
    $('#cx-typing').hidden = true;
    $('#cx-logo').classList.remove('speaking');
    load({ force: true });
    $('#cx-text').focus({ preventScroll: true });
  }

  function tick() {
    clearTimeout(S.timer);
    if ($('#view-cockerel').classList.contains('hidden')) return;
    S.timer = setTimeout(async () => {
      if (!document.hidden) await load();
      tick();
    }, REFRESH_MS);
  }

  window.cockerelOpen = () => {
    document.title = 'Cockerel';
    S.seen = null;
    S.last = '';
    if (!S.built) {
      S.built = true;
      $('#cx-logo').append(avatar());
      $('#cx-form').addEventListener('submit', (e) => { e.preventDefault(); send($('#cx-text').value); });
      $('#cx-pause').addEventListener('click', async () => {
        const paused = $('#cx-pause').textContent === 'Pause';
        try { await api('PUT', '/api/admin/cockerel', { paused }); } catch (err) { $('#cx-more').hidden = false; $('#cx-more').textContent = err.message; }
        load({ force: true });
      });
      $('#cx-steps').addEventListener('click', (e) => {
        S.steps = !S.steps;
        e.currentTarget.setAttribute('aria-pressed', String(S.steps));
        load({ force: true });
      });
      $('#cx-pill').addEventListener('click', (e) => {
        S.open = !S.open;
        e.currentTarget.setAttribute('aria-expanded', String(S.open));
        $('#cx-more').hidden = !S.open;
      });
    }
    load({ force: true });
    tick();
  };

  // Admin → Server → Cockerel
  const form = () => $('#cockerel-admin');
  window.cockerelAdminLoad = async () => {
    try {
      const c = await api('GET', '/api/admin/cockerel');
      const f = form();
      f.url.value = c.url;
      f.secret.value = '';
      f.secret.placeholder = c.hasSecret ? 'Saved. Paste a new one to change it' : '24 or more characters';
      f.sizeGb.value = c.sizeGb;
      f.dayGb.value = c.dayGb;
    } catch { /* the Admin page shows its own errors */ }
  };
  document.addEventListener('submit', async (e) => {
    if (e.target !== form()) return;
    e.preventDefault();
    const f = e.target;
    const body = { url: f.url.value, sizeGb: f.sizeGb.value, dayGb: f.dayGb.value };
    if (f.secret.value) body.secret = f.secret.value;
    try { await api('PUT', '/api/admin/cockerel', body); flash(f, 'Saved'); window.cockerelAdminLoad(); } catch (err) { flash(f, err.message, false); }
  });
})();
