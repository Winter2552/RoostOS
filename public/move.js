'use strict';

// The "Move to ..." screen shared by Glint (Google Photos) and Nest (Google
// Drive): the zips waiting in the folder, Start/Stop, progress, the counts and
// anything that went wrong. Each app says what to call things and how to talk
// to its server; this draws the page and keeps it up to date.
//
// It asks the server for progress only while a move is running and the page
// is showing, so an idle screen costs nothing.
//
//   call(method, path, body)  -> the server's status; path is '' or '/start' ...
//   mount()                   -> the element to draw into
//   showing()                 -> true while this screen is on show
//   intro, steps              -> text and list items above the zip list
//   stats(counts)             -> [[number, label], ...]
//   noun                      -> 'Glint' or 'Nest': the button says "Move to <noun>"
//   deleteZips()              -> asks, then deletes (the app owns its dialog)
//   addZips()                 -> opens the file picker
//   extra(running)            -> optional element shown below everything else
window.createMove = function createMove(o) {
  const { el, bytes, coarse } = o;
  const M = { status: null, deleteEach: false, timer: null };

  async function fetchStatus() {
    M.status = await o.call('GET', '');
    return M.status;
  }

  function poll() {
    clearTimeout(M.timer);
    const job = M.status && M.status.job;
    if (!o.showing() || !job || !job.running) return;
    M.timer = setTimeout(refresh, 1500);
  }

  async function refresh() {
    try {
      const was = M.status && M.status.job && M.status.job.running;
      await fetchStatus();
      if (!o.showing()) return;
      if (was && !M.status.job.running && o.finished) o.finished();
      render();
    } catch { /* try again on the next poll */ }
    poll();
  }

  async function send(path, body) {
    try {
      M.status = await o.call('POST', path, body || {});
    } catch (err) {
      o.toast(err.message);
    }
    render();
    poll();
  }

  function render() {
    const m = M.status;
    const body = o.mount();
    if (!m) { body.replaceChildren(el('div', { class: 'muted glint-note', text: 'Loading…' })); return; }
    const job = m.job;
    const running = Boolean(job && job.running);
    const c = m.counts;
    const worked = c.moved + c.nodate + c.dup + c.skipped + c.problem;
    const out = [];

    out.push(el('div', { class: 'gmove-intro' },
      el('p', { class: 'muted', text: o.intro }),
      el('ol', { class: 'gmove-steps' }, ...o.steps.map((s) => el('li', {}, ...(Array.isArray(s) ? s : [s]))))));

    const zipRows = m.zips.map((z) => el('div', { class: 'gmove-zip' },
      el('span', { class: 'gmove-name', text: z.name }),
      el('span', { class: 'mono muted', text: `${bytes(z.size)}${z.done ? ` · ${z.done} done` : ''}${z.problems ? ` · ${z.problems} problem${z.problems === 1 ? '' : 's'}` : ''}` })));
    out.push(el('div', { class: 'gmove-zips' }, ...zipRows,
      running ? null : el('button', { type: 'button', class: 'btn ghost small', text: m.zips.length ? 'Add more zips' : 'Add zips', onclick: o.addZips }),
      !m.zips.length && !running ? el('span', { class: 'mono muted', text: coarse.matches ? '' : 'or drop them anywhere on this page' }) : null));

    if (running) {
      const pct = job.total ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
      out.push(el('div', { class: 'gmove-run' },
        el('b', { text: job.phase === 'reading' ? 'Reading your zips…' : `Moving ${job.done.toLocaleString()} of ${job.total.toLocaleString()}` }),
        el('div', { class: 'meter' }, el('i', { style: `width:${job.phase === 'reading' ? 2 : Math.max(2, pct)}%` })),
        el('span', { class: 'mono muted gmove-current', text: job.stopping ? 'Stopping after this one…' : job.current }),
        job.stopping ? null : el('button', { type: 'button', class: 'btn ghost small', text: 'Stop', onclick: () => send('/stop') })));
    } else if (m.zips.length) {
      const tick = el('input', { type: 'checkbox', checked: M.deleteEach, onchange: (e) => { M.deleteEach = e.target.checked; } });
      out.push(el('div', { class: 'gmove-start' },
        el('button', { type: 'button', class: 'btn', text: job && job.finished ? 'Move again' : worked ? 'Carry on moving' : `Move to ${o.noun}`, onclick: () => send('/start', { deleteZips: M.deleteEach }) }),
        el('label', { class: 'gmove-tick' }, tick, el('span', { text: 'Delete each zip when it is done, to free space' }))));
    }

    if (job && job.error) out.push(el('p', { class: 'gmove-error', role: 'alert', text: job.error }));

    if (worked) {
      out.push(el('div', { class: 'gmove-stats' }, ...o.stats(c).map(([n, label]) =>
        el('div', { class: 'gmove-stat' }, el('b', { text: n.toLocaleString() }), el('span', { class: 'mono muted', text: label })))));
      if (o.note && o.note(c)) out.push(el('p', { class: 'mono muted glint-note', text: o.note(c) }));
    }
    if (m.problems.length) {
      out.push(el('details', { class: 'gmove-problems' }, el('summary', { text: `Show problems (${c.problem.toLocaleString()})` }),
        ...m.problems.map((p) => el('div', { class: 'gmove-problem' }, el('b', { text: p.name }), el('span', { class: 'mono muted', text: `${p.zip} · ${p.note}` })))));
    }
    if (m.zips.length && !running && job && job.finished) {
      out.push(el('div', { class: 'gmove-done' },
        el('b', { text: 'All done' }),
        el('span', { class: 'muted', text: o.doneText }),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Delete the zips', onclick: () => o.deleteZips((path) => send(path)) })));
    }
    if (o.extra) out.push(o.extra(running));
    body.replaceChildren(el('div', { class: 'gmove' }, ...out.filter(Boolean)));
  }

  return { get status() { return M.status; }, fetchStatus, refresh, render, poll, send };
};
