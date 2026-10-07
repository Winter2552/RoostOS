'use strict';

// Roost dashboard client. Plain JS, no build step.

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  orbit: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4.6"/><ellipse cx="12" cy="12" rx="10" ry="4.6" transform="rotate(60 12 12)"/>',
  folder: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M3 10.5h18"/>',
  spark: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
};

const state = { serverName: 'Roost', user: null, apps: [], status: {}, users: [] };

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function icon(name) {
  const span = el('span', { class: 'icon-tile', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${ICONS[name] || ICONS.grid}</svg>`;
  return span;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showWelcome(false);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(form, text, ok = true) {
  const msg = $('.msg', form);
  msg.textContent = text;
  msg.className = `msg ${ok ? 'ok' : 'error'}`;
}

function resolveUrl(url) {
  return url.replace(/\{host\}/g, location.hostname);
}


function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function setServerName(name) {
  state.serverName = name;
  document.title = name;
  document.querySelectorAll('[data-server-name]').forEach((n) => { n.textContent = name; });
}

// ---------- welcome: setup / sign in ----------

let setupMode = false;

function showWelcome(setup) {
  setupMode = setup;
  state.user = null;
  $('#shell').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
  $('#display-name-field').classList.toggle('hidden', !setup);
  $('#welcome-lead').textContent = setup ? 'First run · create the admin account' : 'Sign in to your home server';
  $('#welcome-form [name=password]').autocomplete = setup ? 'new-password' : 'current-password';
  $('#welcome-submit').textContent = setup ? 'Create account' : 'Continue';
}

$('#welcome-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value, password: f.password.value };
  if (setupMode) body.displayName = f.displayName.value;
  try {
    const { user } = await api('POST', setupMode ? '/api/setup' : '/api/login', body);
    f.reset();
    $('#welcome-msg').textContent = '';
    await enter(user);
  } catch (err) {
    $('#welcome-msg').textContent = err.message;
  }
});

// ---------- shell ----------

async function enter(user) {
  state.user = user;
  $('#welcome').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('hidden', user.role !== 'admin'));
  renderUser();
  await loadApps();
  loadSystem();
  route();
}

function renderUser() {
  const u = state.user;
  const name = u.displayName || u.username;
  $('#avatar').textContent = name.charAt(0).toUpperCase();
  $('#who-name').textContent = name;
  $('#hero-name').textContent = name;
  $('#profile-role').textContent = u.role;
  $('#profile-form').displayName.value = u.displayName;
  $('#profile-form').username.value = u.username;
}

const VIEWS = ['apps', 'status', 'profile', 'admin'];

function route() {
  if (!state.user) return;
  let view = (location.hash.replace('#/', '') || 'apps');
  if (!VIEWS.includes(view) || (view === 'admin' && state.user.role !== 'admin')) view = 'apps';
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'admin') loadAdmin();
  if (view === 'status') loadStatus();
}

window.addEventListener('hashchange', route);

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showWelcome(false);
});

// ---------- apps ----------

async function loadApps() {
  const { apps } = await api('GET', '/api/apps');
  state.apps = apps;
  renderApps();
  api('GET', '/api/apps/status').then(({ status }) => { state.status = status; renderApps(); }).catch(() => {});
}

function renderApps() {
  const list = $('#apps');
  const total = state.apps.length;
  if (!total) {
    list.replaceChildren(el('div', { class: 'empty mono', text: 'No apps yet. Ask an admin to give you access.' }));
    return;
  }
  list.replaceChildren(...state.apps.map((app) => {
    const status = app.url ? state.status[app.id] || 'checking' : 'unset';
    const label = { online: 'Online', offline: 'Offline', checking: 'Checking', unset: 'Not set up' }[status];
    const isAdmin = state.user.role === 'admin';
    const children = [
      icon(app.icon),
      el('div', {}, el('div', { class: 'mono muted', text: app.tagline }), el('h3', { text: app.name })),
      el('p', { text: app.description }),
      el('div', { class: 'app-foot mono' },
        el('span', {}, el('span', { class: `dot ${status}` }), label),
        el('span', { text: app.url ? 'Open →' : isAdmin ? 'Add link' : '' })),
    ];
    return app.url
      ? el('a', { class: 'card app-card', href: resolveUrl(app.url), target: '_blank', rel: 'noopener' }, children)
      : el('div', { class: 'card app-card disabled' }, children);
  }));
}

// ---------- system panel ----------

async function loadSystem() {
  try {
    const s = await api('GET', '/api/system');
    const used = s.memory.total - s.memory.free;
    $('#stat-uptime').textContent = duration(s.uptime);
    $('#stat-mem').textContent = `${bytes(used)} / ${bytes(s.memory.total)}`;
    $('#stat-load').textContent = `${s.load[0].toFixed(2)} · ${s.cpus} cpu`;
    $('#stat-disk').textContent = s.disk ? `${bytes(s.disk.free)} free` : '—';
    $('#foot-host').textContent = s.hostname;
  } catch {
    // The panel just keeps its dashes if stats aren't available.
  }
}

// ---------- status page ----------

const STATUS_REFRESH_MS = 5 * 1000;
const FULL_AT = 90;
let statusBusy = false;

function pct(used, total) {
  return total ? Math.round((used / total) * 100) : 0;
}

function meter(percent) {
  return el('div', { class: `meter${percent >= FULL_AT ? ' high' : ''}`, role: 'meter', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    el('i', { style: `width:${Math.min(100, percent)}%` }));
}

function statCard(label, value, sub, bar) {
  return el('div', { class: 'card stat-card' },
    el('div', { class: 'mono muted', text: label }),
    el('div', { class: 'stat-value', text: value }),
    bar === undefined ? null : meter(bar),
    el('div', { class: 'mono muted stat-sub', text: sub }));
}

async function loadStatus() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    renderStatus(await api('GET', '/api/status'));
  } catch {
    $('#status-updated').textContent = 'Roost is not answering';
    setSummary('offline', "Can't reach the server right now");
  } finally {
    statusBusy = false;
  }
}

function setSummary(kind, text) {
  $('#status-summary').replaceChildren(el('span', { class: `dot ${kind}` }), el('span', { text }));
}

function renderStatus(s) {
  const memUsed = s.memory.total - s.memory.available;
  const memPct = pct(memUsed, s.memory.total);
  $('#status-server').replaceChildren(
    statCard('Uptime', duration(s.uptime), `Roost up ${duration(s.roostUptime)}`),
    statCard('CPU', `${Math.round(s.cpu.percent)}%`, `Load ${s.cpu.load[0].toFixed(2)} · ${s.cpu.cores} cores`, s.cpu.percent),
    statCard('Memory', bytes(memUsed), `${memPct}% of ${bytes(s.memory.total)}`, memPct),
    statCard('Host', s.hostname, s.platform),
  );

  $('#status-disks').replaceChildren(...s.disks.map((d) => {
    if (d.missing) return statCard(d.label, 'Not found', d.path);
    const used = d.total - d.free;
    return statCard(d.label, `${bytes(d.free)} free`, `${bytes(used)} of ${bytes(d.total)} used`, pct(used, d.total));
  }));

  const appLabel = { online: 'Online', offline: 'Offline', unset: 'Not set up' };
  $('#status-apps').replaceChildren(...(s.apps.length ? s.apps.map((a) =>
    el('div', { class: `card stat-card app-status ${a.state}` },
      el('div', { class: 'app-status-head' }, icon(a.icon), el('div', { class: 'mono muted', text: a.tagline })),
      el('div', { class: 'stat-value', text: a.name }),
      el('div', { class: 'mono stat-sub' },
        el('span', {}, el('span', { class: `dot ${a.state}` }), appLabel[a.state]),
        a.ms !== undefined ? el('span', { class: 'muted', text: ` · ${a.ms} ms` }) : null)),
  ) : [el('div', { class: 'empty mono', text: 'No apps to check.' })]));

  const problems = [
    ...s.apps.filter((a) => a.state === 'offline').map((a) => `${a.name} is offline`),
    ...s.disks.filter((d) => !d.missing && pct(d.total - d.free, d.total) >= FULL_AT).map((d) => `${d.label} drive is nearly full`),
    ...s.disks.filter((d) => d.missing).map((d) => `${d.label} drive not found`),
    ...(memPct >= FULL_AT ? ['Memory is nearly full'] : []),
  ];
  setSummary(problems.length ? 'offline' : 'online', problems.length ? problems.join(' · ') : 'Everything is running');
  $('#status-updated').textContent = `Updated ${new Date(s.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const h = now.getHours();
  $('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---------- profile ----------

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('PATCH', '/api/me', { displayName: e.target.displayName.value });
    state.user = user;
    renderUser();
    flash(e.target, 'Saved');
  } catch (err) { flash(e.target, err.message, false); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PATCH', '/api/me', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
    f.reset();
    flash(f, 'Password changed');
  } catch (err) { flash(f, err.message, false); }
});

// ---------- admin ----------

async function loadAdmin() {
  const [{ users }, { apps }] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/apps')]);
  state.users = users;
  state.apps = apps;
  $('#settings-form').serverName.value = state.serverName;
  renderAppsEditor();
  renderUsers();
  $('#new-user-apps').replaceChildren(...appChecks(null));
}

function appChecks(selected) {
  return state.apps.map((a) => el('label', {},
    el('input', { type: 'checkbox', value: a.id, checked: selected === null || selected.includes(a.id) }), a.name));
}

function checkedApps(container) {
  return [...container.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
}

function appEditorRow(app) {
  const iconSelect = el('select', { name: 'icon' }, Object.keys(ICONS).map((k) => el('option', { value: k, text: k, selected: k === app.icon })));
  const row = el('div', { class: 'admin-app', 'data-id': app.id || '' },
    el('div', { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), el('input', { type: 'text', name: 'name', value: app.name || '', maxlength: 40, required: true })),
      el('label', { class: 'field' }, el('span', { text: 'Tagline' }), el('input', { type: 'text', name: 'tagline', value: app.tagline || '', maxlength: 40 })),
      el('label', { class: 'field' }, el('span', { text: 'Link' }), el('input', { type: 'text', name: 'url', value: app.url || '', placeholder: 'http://{host}:8096', spellcheck: 'false' })),
      el('label', { class: 'field' }, el('span', { text: 'Icon' }), iconSelect),
    ),
    el('div', { class: 'row' },
      el('label', { class: 'field', style: 'flex:1' }, el('span', { text: 'Description' }), el('input', { type: 'text', name: 'description', value: app.description || '', maxlength: 200 })),
      el('button', { class: 'btn danger small', type: 'button', text: 'Remove', onclick: () => row.remove() })),
  );
  return row;
}

function renderAppsEditor() {
  $('#apps-editor').replaceChildren(...state.apps.map(appEditorRow));
}

$('#add-app').addEventListener('click', () => {
  $('#apps-editor').append(appEditorRow({ icon: 'grid' }));
});

$('#apps-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apps = [...document.querySelectorAll('#apps-editor .admin-app')].map((row) => {
    const get = (n) => $(`[name=${n}]`, row).value;
    const app = { name: get('name'), tagline: get('tagline'), url: get('url'), icon: get('icon'), description: get('description') };
    if (row.dataset.id) app.id = row.dataset.id;
    return app;
  });
  try {
    ({ apps: state.apps } = await api('PUT', '/api/admin/apps', { apps }));
    flash(e.target, 'Apps saved');
    renderAppsEditor();
    renderUsers();
    $('#new-user-apps').replaceChildren(...appChecks(null));
    loadApps();
  } catch (err) { flash(e.target, err.message, false); }
});

function renderUsers() {
  $('#users').replaceChildren(...state.users.map((u) => {
    const isMe = u.id === state.user.id;
    const checks = el('div', { class: 'checks' }, appChecks(u.apps));
    const msg = el('div', { class: 'msg' });
    const save = async () => {
      try {
        await api('PATCH', `/api/admin/users/${u.id}`, { apps: checkedApps(checks) });
        msg.className = 'msg ok'; msg.textContent = 'Saved';
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    const remove = async () => {
      if (!confirm(`Remove ${u.displayName}? They will no longer be able to sign in.`)) return;
      try {
        await api('DELETE', `/api/admin/users/${u.id}`);
        loadAdmin();
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    return el('div', { class: 'user-row' },
      el('div', { class: 'who' },
        el('span', { class: 'avatar', text: (u.displayName || u.username).charAt(0).toUpperCase() }),
        el('div', {}, el('div', { text: u.displayName }), el('div', { class: 'mono muted', text: `@${u.username}` })),
        el('span', { class: 'pill', text: u.role })),
      u.role === 'admin'
        ? el('span', { class: 'mono muted', text: 'Sees every app' })
        : el('div', { class: 'row', style: 'margin:0' }, checks, el('button', { class: 'btn ghost small', type: 'button', text: 'Save', onclick: save })),
      isMe ? null : el('button', { class: 'btn danger small', type: 'button', text: 'Remove', onclick: remove }),
      msg);
  }));
}

$('#new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/admin/users', {
      displayName: f.displayName.value,
      username: f.username.value,
      password: f.password.value,
      role: f.role.value,
      apps: checkedApps($('#new-user-apps')),
    });
    f.reset();
    flash(f, 'User added');
    loadAdmin();
  } catch (err) { flash(f, err.message, false); }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { settings } = await api('PATCH', '/api/admin/settings', { serverName: e.target.serverName.value });
    setServerName(settings.serverName);
    flash(e.target, 'Saved');
  } catch (err) { flash(e.target, err.message, false); }
});

// ---------- boot ----------

(async function boot() {
  tickClock();
  setInterval(tickClock, 30 * 1000);
  setInterval(() => { if (state.user && !$('#view-apps').classList.contains('hidden')) loadSystem(); }, 15 * 1000);
  // The status page refreshes itself while it is open and the tab is visible.
  setInterval(() => {
    if (state.user && !document.hidden && !$('#view-status').classList.contains('hidden')) loadStatus();
  }, STATUS_REFRESH_MS);
  const s = await api('GET', '/api/state');
  setServerName(s.serverName);
  if (s.user) await enter(s.user);
  else showWelcome(s.setupRequired);
})();
