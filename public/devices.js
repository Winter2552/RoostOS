'use strict';

// Admin → Devices: everything on the home network and what it seems to be
// doing. Raven's account only; the server answers 404 to anyone else and from
// outside the house, and app.js only shows this section when it does not.
// Loaded after app.js and uses its helpers ($, el, api, flash, ago).

(function devices() {
  const view = { data: null, filter: null, editing: null };
  const TYPES = [['phone', 'Phone'], ['tablet', 'Tablet'], ['computer', 'Computer'], ['tv', 'TV'], ['console', 'Games console'], ['printer', 'Printer'], ['camera', 'Camera'], ['home', 'Smart home'], ['server', 'Server'], ['router', 'Router'], ['other', 'Other']];
  const typeName = (t) => (TYPES.find((x) => x[0] === t) || [, 'Other'])[1];
  const panel = () => $('#finder-panel');

  const tagName = (t) => ({ raven: (state.user && (state.user.displayName || state.user.username)) || 'Me', family: 'Family', guest: 'Guest', server: 'Server', other: 'Other' }[t] || '');

  function say(text, ok = true) { flash(panel(), text, ok); }

  async function call(method, url, body) {
    try {
      view.data = await api(method, url, body);
      render();
    } catch (err) { say(err.message, false); }
  }

  function banner(data) {
    const box = $('#finder-banner');
    const h = data.helper;
    const msg = {
      off: ['The device helper is not set up yet', 'Add the roost-lan service from the compose file, then redeploy. Admin → Setup has the steps.'],
      missing: ['Waiting for the first sweep', 'The helper has not left a result yet. It sweeps when it starts, then every half hour.'],
      stale: ['The helper has stopped answering', 'The list below is from the last sweep. Check the roost-lan service in ZimaOS.'],
      error: ['The last sweep failed', h.error || 'The helper could not find the home network.'],
    }[h.state];
    const added = [];
    if (msg) {
      added.push(el('div', {}, el('b', { text: msg[0] }), el('div', { class: 'mono muted', text: msg[1] })));
    } else if (!data.baselined && data.devices.length) {
      added.push(el('div', {}, el('b', { text: `First sweep found ${data.devices.length} device${data.devices.length === 1 ? '' : 's'}` }),
        el('div', { class: 'mono muted', text: 'Mark them as known so Roost only alerts you about devices that join after today.' })),
      el('button', { class: 'btn', type: 'button', text: 'Mark all as known', onclick: () => call('POST', '/api/admin/devices/known-all') }));
    } else if (data.counts.new) {
      const first = data.devices.find((d) => !d.known);
      added.push(el('div', {}, el('b', { text: `${data.counts.new} new device${data.counts.new === 1 ? '' : 's'} on your network` }),
        el('div', { class: 'mono muted', text: `${first.name} · ${first.ip}${first.private ? ' · private Wi‑Fi address' : first.vendor ? ` · ${first.vendor}` : ''}` })),
      el('button', { class: 'btn', type: 'button', text: 'Name it', onclick: () => { view.editing = first.mac; view.filter = 'new'; render(); } }));
    }
    box.className = added.length ? 'devices-banner' : 'hidden';
    box.replaceChildren(...added);
  }

  function tiles(data) {
    const c = data.counts;
    const tile = (big, label, small) => el('div', { class: 'devices-tile' }, el('small', { class: 'mono muted', text: label }), el('b', { text: String(big) }), el('small', { class: 'mono muted', text: small }));
    $('#finder-tiles').replaceChildren(
      tile(c.online, 'Online now', `of ${c.known} known`),
      tile(c.new, 'New', c.new ? 'needs a look' : 'nothing new'),
      tile(c.away, 'Away', 'not seen in the last sweep'),
      tile(c.watch, 'Watch', c.watch ? 'open risky port' : 'all quiet'));
  }

  function editor(d) {
    const name = el('input', { type: 'text', maxlength: 40, value: d.label, placeholder: d.name, 'aria-label': 'Name' });
    const type = el('select', { 'aria-label': 'Type' }, ...TYPES.map(([v, l]) => el('option', { value: v, text: l, selected: v === d.type })));
    const tag = el('select', { 'aria-label': 'Whose' }, el('option', { value: '', text: 'Whose? (none)' }),
      ...['raven', 'family', 'guest', 'server', 'other'].map((v) => el('option', { value: v, text: tagName(v), selected: v === d.tag })));
    const save = () => { view.editing = null; call('PATCH', `/api/admin/devices/${d.mac.replace(/:/g, '-')}`, { label: name.value, type: type.value, tag: tag.value, ...(d.known ? {} : { known: true }) }); };
    return el('div', { class: 'devices-edit' },
      name, el('div', { class: 'devices-edit-row' }, type, tag),
      el('div', { class: 'mono muted', text: `${d.mac}${d.vendor ? ` · ${d.vendor}` : ''}${d.private ? ' · private address (changes per network)' : ''} · first seen ${ago(d.firstSeen)}` }),
      el('div', { class: 'devices-edit-row' },
        el('button', { class: 'btn', type: 'button', text: d.known ? 'Save' : 'It’s mine', onclick: save }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { view.editing = null; render(); } }),
        el('button', { class: 'btn ghost', type: 'button', text: d.known ? 'Forget' : 'Not mine', onclick: () => { view.editing = null; call('DELETE', `/api/admin/devices/${d.mac.replace(/:/g, '-')}`); } })));
  }

  function row(d) {
    const open = view.editing === d.mac;
    const what = d.doing ? `Doing: ${d.doing}`
      : d.risky.length ? `Open: ${d.risky.map((r) => `${r.port} ${r.name}`).join(', ')}. ${d.risky[0].name} is risky.`
        : d.online && d.ports.length ? `Open: ${d.ports.slice(0, 4).map((p) => `${p.port} ${p.name}`).join(', ')}`
          : d.online ? 'Doing: nothing Roost can see' : `Last seen ${ago(d.lastSeen)}`;
    const pill = !d.known ? el('span', { class: 'pill pending', text: 'New' }) : d.risky.length ? el('span', { class: 'pill pending', text: 'Watch' }) : d.tag ? el('span', { class: 'pill', text: tagName(d.tag) }) : '';
    return el('li', { class: 'security-row devices-row' },
      el('span', { class: `dot ${d.online ? 'online' : ''}`, title: d.online ? 'Online' : 'Away' }),
      el('div', { class: 'sentinel-main' },
        el('div', { class: 'security-what', text: d.name }),
        el('div', { class: 'mono muted', text: [d.ip, d.vendor || (d.private ? 'Private address' : ''), typeName(d.type)].filter(Boolean).join(' · ') }),
        el('div', { class: 'mono muted', text: what }),
        open ? editor(d) : ''),
      el('div', { class: 'sentinel-actions' }, pill,
        open ? '' : el('button', { class: 'btn ghost small', type: 'button', text: d.known ? 'Edit' : 'Name', onclick: () => { view.editing = d.mac; render(); } })));
  }

  function render() {
    const data = view.data;
    if (!data) return;
    banner(data);
    tiles(data);
    if (!view.filter) view.filter = !data.baselined ? 'all' : 'online';
    for (const c of $('#finder-filter').children) if (c.dataset.f) c.setAttribute('aria-pressed', String(c.dataset.f === view.filter));
    const keep = { online: (d) => d.online, all: () => true, new: (d) => !d.known, away: (d) => d.known && !d.online }[view.filter];
    const list = data.devices.filter(keep);
    $('#finder-list').replaceChildren(...(list.length ? list.map(row) : [el('li', { class: 'mono muted', text: data.devices.length ? 'Nothing here.' : 'No devices yet.' })]));
    $('#finder-lead').textContent = data.scanAt ? `Only you can see this · home network only · last sweep ${ago(data.scanAt)}` : 'Only you can see this · home network only';
    for (const box of $('#finder-rules').querySelectorAll('input')) box.checked = Boolean(data.rules[box.name]);
  }

  async function load() {
    try {
      view.data = await api('GET', '/api/admin/devices');
      render();
      panel().querySelector('.msg').textContent = '';
    } catch (err) { say(err.message, false); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#finder-filter').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-f]');
      if (chip) { view.filter = chip.dataset.f; render(); }
    });
    $('#finder-scan').addEventListener('click', async () => {
      const btn = $('#finder-scan');
      btn.disabled = true;
      btn.textContent = 'Scanning…';
      try {
        await api('POST', '/api/admin/devices/scan');
        // One look a few seconds later, when the sweep has finished; no polling.
        setTimeout(() => { load(); btn.disabled = false; btn.textContent = 'Scan now'; }, 7000);
      } catch (err) { say(err.message, false); btn.disabled = false; btn.textContent = 'Scan now'; }
    });
    $('#finder-rules').addEventListener('change', (e) => {
      call('PUT', '/api/admin/devices/rules', { [e.target.name]: e.target.checked });
    });
  });

  window.devicesLoad = load;
})();
