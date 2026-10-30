'use strict';

// Cockerel: chat with your agent and watch what he is doing. The page only
// refreshes while it is open and visible; when you leave it, nothing runs.

(() => {
  const REFRESH_MS = 6000;
  const S = { built: false, timer: null, busy: false, all: false, last: '' };
  const STEPS = ['Requested', 'Finding', 'Downloading', 'Added'];

  const when = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function statusLine(d) {
    if (!d.enabled) return 'Not linked yet. Link him under Admin → Server → Cockerel.';
    if (d.paused) return 'Paused. He is not listening and will not act.';
    const s = d.status || {};
    if (!s.reachable) return "Not answering. Check that his VM is running.";
    const bits = ['Running'];
    if (s.vpn) bits.push(s.vpn === 'up' ? 'VPN on' : 'VPN OFF, downloads stopped');
    if (Number.isFinite(s.cpu)) bits.push(`CPU ${s.cpu}%`);
    if (Number.isFinite(s.memMb)) bits.push(`RAM ${Math.round(s.memMb)} MB`);
    if (Number.isFinite(s.diskPct)) bits.push(`disk ${s.diskPct}%`);
    bits.push(`${d.todayGb} of ${d.dayGb} GB today`);
    return bits.join(' · ');
  }

  function jobCard(j) {
    const at = STEPS.indexOf(j.state);
    return el('div', { class: `cx-job${j.state === 'Failed' ? ' failed' : ''}` },
      el('strong', { text: j.title || 'Job' }),
      el('div', { class: 'cx-steps', 'aria-label': j.state }, STEPS.map((s, i) => el('span', { class: i <= at ? 'on' : '', text: s }))),
      j.state === 'Downloading' && j.progress > 0 ? el('div', { class: 'cx-bar' }, el('i', { style: `width:${j.progress}%` })) : null,
      j.state === 'Failed' ? el('span', { class: 'muted', text: 'Failed' }) : null);
  }

  function entry(e, answer) {
    if (e.kind === 'you' || e.kind === 'cockerel') return el('div', { class: `cx-msg ${e.kind}` }, el('p', { text: e.text }), el('time', { text: when(e.at) }));
    if (e.kind === 'ask') {
      return el('div', { class: 'cx-msg cockerel ask' }, el('p', { text: e.text }),
        e.answer ? el('span', { class: 'muted', text: `You said ${e.answer}` })
          : el('div', { class: 'row' }, e.options.map((o, i) => el('button', { class: `btn small${i ? ' ghost' : ''}`, type: 'button', text: o, onclick: () => answer(e, o) }))));
    }
    return el('div', { class: 'cx-step' }, el('time', { text: when(e.at) }), el('span', { text: e.text }));
  }

  async function load(opts = {}) {
    let d;
    try { d = await api('GET', '/api/cockerel'); } catch (err) { $('#cx-status').textContent = err.message; return; }
    const key = JSON.stringify([d.log.slice(-1), d.jobs, d.paused, d.status, S.all]);
    $('#cx-status').textContent = statusLine(d);
    $('#cx-pause').textContent = d.paused ? 'Resume' : 'Pause';
    $('#cx-pause').hidden = !d.enabled;
    $('#cx-form').hidden = !d.enabled || d.paused;
    if (key === S.last && !opts.force) return;
    S.last = key;
    const jobs = $('#cx-jobs');
    jobs.replaceChildren(...d.jobs.slice(0, 4).map(jobCard));
    jobs.hidden = !d.jobs.length;
    const feed = $('#cx-feed');
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const shown = d.log.filter((e) => S.all || e.kind !== 'note' && e.kind !== 'event');
    feed.replaceChildren(...(shown.length ? shown.map((e) => entry(e, answer)) : [el('p', { class: 'muted', text: d.enabled ? 'Say hello, or ask him to find something for Roostflix.' : 'Once he is linked, you can talk to him here.' })]));
    if (stick || opts.force) feed.scrollTop = feed.scrollHeight;
  }

  async function answer(e, choice) {
    try { await api('POST', '/api/cockerel/answer', { id: e.id, choice }); } catch (err) { $('#cx-status').textContent = err.message; }
    load({ force: true });
  }

  async function send(text) {
    if (S.busy || !text.trim()) return;
    S.busy = true;
    const box = $('#cx-text');
    box.value = '';
    $('#cx-send').disabled = true;
    $('#cx-typing').hidden = false;
    // The message shows at once; his reply arrives when he finishes.
    const sent = api('POST', '/api/cockerel/chat', { text });
    setTimeout(() => load({ force: true }), 300);
    try { await sent; } catch (err) { $('#cx-status').textContent = err.message; }
    S.busy = false;
    $('#cx-send').disabled = false;
    $('#cx-typing').hidden = true;
    load({ force: true });
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
    if (!S.built) {
      S.built = true;
      $('#cx-form').addEventListener('submit', (e) => { e.preventDefault(); send($('#cx-text').value); });
      $('#cx-pause').addEventListener('click', async () => {
        const paused = $('#cx-pause').textContent === 'Pause';
        try { await api('PUT', '/api/admin/cockerel', { paused }); } catch (err) { $('#cx-status').textContent = err.message; }
        load({ force: true });
      });
      $('#cx-all').addEventListener('change', (e) => { S.all = e.target.checked; load({ force: true }); });
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
