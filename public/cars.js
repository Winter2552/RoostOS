'use strict';

// Car log: the garage (one card per car) and a car's page. Everything is
// fetched when the page opens and when something changes; nothing runs on a
// timer. Photos are shrunk in the browser to a small JPEG before they are sent.

(() => {
  const root = () => document.getElementById('cars-root');
  const S = { cars: [], people: [], loaded: false, ask: 0, glint: false };

  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  };

  // replaceChildren would print a literal "null" for an empty slot.
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

  const CAR = '<svg viewBox="0 0 120 50" width="120" height="50" aria-hidden="true"><path d="M6 36 L10 26 Q12 20 20 19 L38 17 L50 7 Q53 5 58 5 H80 Q86 5 90 10 L98 19 L110 22 Q116 24 116 30 V36 H104 M96 36 H30" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><circle cx="24" cy="37" r="8" fill="var(--bg)" stroke="currentColor" stroke-width="2.5"/><circle cx="96" cy="37" r="8" fill="var(--bg)" stroke="currentColor" stroke-width="2.5"/></svg>';


  const KINDS = [['mot', 'MOT'], ['tax', 'Road tax'], ['insurance', 'Insurance'], ['service', 'Service'], ['cover', 'Breakdown cover'], ['custom', 'Other']];
  const niceDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const leftText = (n) => (n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${n} days`);
  const pill = (n) => h('span', { class: `car-pill${n <= 30 ? ' warn' : ''}${n < 0 ? ' late' : ''}`, text: leftText(n) });

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : body ? { 'Content-Type': 'image/jpeg' } : {},
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong'), { code: data && data.code, status: res.status });
    return data;
  }

  const say = (text) => {
    const n = document.getElementById('cars-say');
    if (n) n.textContent = text || '';
  };

  async function load() {
    const data = await api('GET', '/api/cars');
    S.cars = data.cars;
    S.people = data.people;
    S.loaded = true;
  }

  const outline = () => {
    const d = h('div', { class: 'car-ph' });
    d.innerHTML = CAR; // code-check: ok (fixed drawing, no user text in it)
    return d;
  };
  const photo = (car, cls = 'car-photo') => h('div', { class: cls }, car.photo ? h('img', { src: car.photo, alt: '', loading: 'lazy', draggable: 'false' }) : outline());

  function garage() {
    document.title = 'Cars';
    const r = root();
    const live = S.cars.filter((c) => !c.archived);
    const old = S.cars.filter((c) => c.archived);
    fill(r, 
      h('div', { class: 'car-bar' }, h('h2', { text: 'Cars' }), h('a', { class: 'btn small', href: '#/cars/new', text: 'Add a car' })),
      h('p', { class: 'car-say mono', id: 'cars-say', 'aria-live': 'polite' }),
      live.length ? h('div', { class: 'car-grid' }, live.map(tile)) : h('div', { class: 'car-empty' },
        h('p', { text: 'No cars yet.' }),
        h('p', { class: 'muted', text: 'Add yours to keep its dates, fuel and history in one place.' })),
      old.length ? h('details', { class: 'car-old' }, h('summary', { class: 'mono', text: `Archived (${old.length})` }), h('div', { class: 'car-grid' }, old.map(tile))) : null,
    );
  }

  function tile(car) {
    const sub = [car.plate, car.odometer ? `${car.odometer.toLocaleString('en-GB')} ${car.units}` : '', car.role !== 'owner' ? `${car.owner}’s car` : car.household ? 'Household' : car.shares && car.shares.length ? `Shared with ${car.shares.length}` : ''].filter(Boolean).join(' · ');
    return h('a', { class: 'card car-tile', href: `#/cars/${car.id}` }, photo(car, 'car-photo'),
      h('div', { class: 'car-info' },
        h('div', { class: 'car-line' }, h('b', { text: car.name }), car.next ? h('span', { class: 'car-next' }, h('span', { class: 'muted', text: car.next.label }), pill(car.next.daysLeft)) : null),
        h('span', { class: 'muted', text: sub || [car.make, car.model].filter(Boolean).join(' ') || ' ' })));
  }

  // Shrinks any picture to a 900px JPEG, so a 12 MB phone photo becomes ~150 KB.
  function toJpeg(source) {
    return new Promise((resolve, reject) => {
      const url = source instanceof Blob ? URL.createObjectURL(source) : source;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (source instanceof Blob) URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t read that picture'))), 'image/jpeg', 0.82);
      };
      img.onerror = () => reject(new Error('Couldn’t read that picture'));
      img.src = url;
    });
  }

  async function sendPhoto(car, source) {
    say('Saving photo…');
    try {
      const out = await api('PUT', `/api/cars/${car.id}/photo`, await toJpeg(source));
      Object.assign(car, out);
      say('');
      carPage(car.id);
    } catch (err) { say(err.message); }
  }

  function form(car) {
    const f = h('form', { class: 'car-form', autocomplete: 'off' });
    const field = (label, name, attrs = {}) => h('label', {}, h('span', { class: 'mono', text: label }), h('input', { name, value: car ? car[name] ?? '' : '', ...attrs }));
    const pick = (label, name, opts) => h('label', {}, h('span', { class: 'mono', text: label }),
      h('select', { name }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: (car ? car[name] : opts[0][0]) === v }))));
    f.append(
      field('Name', 'name', { maxlength: 40, required: true, placeholder: 'Golf' }),
      field('Number plate', 'plate', { maxlength: 12, placeholder: 'AB12 CDE', autocapitalize: 'characters' }),
      h('div', { class: 'car-two' }, field('Make', 'make', { maxlength: 30 }), field('Model', 'model', { maxlength: 30 })),
      h('div', { class: 'car-two' }, field('Year', 'year', { inputmode: 'numeric', maxlength: 4 }),
        pick('Fuel', 'fuel', [['petrol', 'Petrol'], ['diesel', 'Diesel'], ['hybrid', 'Hybrid'], ['electric', 'Electric'], ['other', 'Other']])),
      pick('Distance', 'units', [['mi', 'Miles'], ['km', 'Kilometres']]),
      h('button', { class: 'btn', type: 'submit', text: car ? 'Save' : 'Add car' }),
    );
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      try {
        const out = car ? await api('PATCH', `/api/cars/${car.id}`, body) : await api('POST', '/api/cars', body);
        await load();
        location.hash = `#/cars/${out.id}`;
      } catch (err) { say(err.message); }
    });
    return f;
  }

  function newCar() {
    document.title = 'Add a car';
    fill(root(), 
      h('div', { class: 'car-bar' }, h('a', { class: 'btn small ghost', href: '#/cars', 'aria-label': 'Back to cars', text: '‹' }), h('h2', { text: 'Add a car' })),
      h('p', { class: 'car-say mono', id: 'cars-say', 'aria-live': 'polite' }),
      form(null));
  }

  function sharePanel(car) {
    const box = h('div', { class: 'card car-share' });
    const save = async (shares, household) => {
      try {
        Object.assign(car, await api('PUT', `/api/cars/${car.id}/share`, { shares, household }));
        say('');
        sharePaint();
      } catch (err) { say(err.message); }
    };
    const current = () => (car.shares || []).map((s) => ({ userId: s.userId, role: s.role }));
    function sharePaint() {
      const left = S.people.filter((p) => !(car.shares || []).some((s) => s.userId === p.id));
      fill(box, 
        h('h3', { text: 'Who can see this car' }),
        h('p', { class: 'muted', text: 'Only you, unless you add someone. Admins don’t get in automatically.' }),
        ...(car.shares || []).map((s) => h('div', { class: 'car-person' }, h('span', { text: s.name }),
          h('select', { 'aria-label': `${s.name}’s access`, onchange: (e) => save(current().map((x) => (x.userId === s.userId ? { ...x, role: e.target.value } : x)), car.household) },
            [['viewer', 'Can look'], ['editor', 'Can add entries']].map(([v, t]) => h('option', { value: v, text: t, selected: s.role === v }))),
          h('button', { class: 'btn small ghost', type: 'button', text: 'Remove', onclick: () => save(current().filter((x) => x.userId !== s.userId), car.household) }))),
        left.length ? h('div', { class: 'car-person' },
          h('select', { id: 'car-add', 'aria-label': 'Add a person' }, left.map((p) => h('option', { value: p.id, text: p.name }))),
          h('button', { class: 'btn small', type: 'button', text: 'Add', onclick: () => save([...current(), { userId: document.getElementById('car-add').value, role: 'viewer' }], car.household) })) : null,
        h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: car.household, onchange: (e) => save(current(), e.target.checked) }), ' Household: everyone with the Cars app can see it'),
      );
    }
    sharePaint();
    return box;
  }

  async function glintPicker(car) {
    const dlg = h('div', { class: 'car-pick card', role: 'dialog', 'aria-label': 'Pick a photo from Glint' }, h('p', { class: 'mono', text: 'Loading…' }));
    const close = () => dlg.remove();
    root().append(dlg);
    try {
      const data = await api('GET', '/api/glint/photos');
      const pics = (data.items || []).filter((p) => p.thumb === 1 && !p.video);
      fill(dlg, 
        h('div', { class: 'car-bar' }, h('b', { text: 'Pick a photo' }), h('button', { class: 'btn small ghost', type: 'button', text: 'Close', onclick: close })),
        pics.length ? h('div', { class: 'car-picks' }, pics.slice(0, 60).map((p) => h('button', { type: 'button', class: 'car-pickbtn', 'aria-label': 'Use this photo', onclick: () => { close(); sendPhoto(car, `/api/glint/thumbs/${p.id}`); } }, h('img', { src: `/api/glint/thumbs/${p.id}`, alt: '', loading: 'lazy' })))) : h('p', { class: 'muted', text: 'No photos in Glint yet.' }));
    } catch (err) { fill(dlg, h('p', { text: err.message }), h('button', { class: 'btn small ghost', type: 'button', text: 'Close', onclick: close })); }
  }


  // ---------- dates ----------

  function dateForm(car, existing) {
    const f = h('form', { class: 'car-form car-dateform', autocomplete: 'off' });
    const kind = h('select', { name: 'kind' }, KINDS.map(([v, t]) => h('option', { value: v, text: t, selected: (existing ? existing.kind : 'mot') === v })));
    const label = h('input', { name: 'label', maxlength: 40, value: existing && existing.kind === 'custom' ? existing.label : '', placeholder: 'What is it? (tyres, cambelt…)' });
    const labelBox = h('label', { class: 'hidden' }, h('span', { class: 'mono', text: 'Name' }), label);
    const showLabel = () => labelBox.classList.toggle('hidden', kind.value !== 'custom');
    kind.addEventListener('change', showLabel);
    showLabel();
    f.append(
      h('label', {}, h('span', { class: 'mono', text: 'What' }), kind), labelBox,
      h('label', {}, h('span', { class: 'mono', text: 'Due on' }), h('input', { name: 'due', type: 'date', required: true, value: existing ? existing.due : '' })),
      h('label', {}, h('span', { class: 'mono', text: 'Repeats every (months, 0 for once)' }), h('input', { name: 'repeatMonths', inputmode: 'numeric', maxlength: 3, value: existing ? existing.repeatMonths : '' , placeholder: 'Usually 12' })),
      h('div', { class: 'car-actions' }, h('button', { class: 'btn small', type: 'submit', text: existing ? 'Save' : 'Add date' }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => carPage(car.id) })),
      h('p', { class: 'muted car-soon', text: 'Roost reminds you 30 days and 7 days before, and on the day.' }),
    );
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      if (body.kind !== 'custom') body.label = '';
      try {
        Object.assign(car, existing ? await api('PATCH', `/api/cars/${car.id}/dates/${existing.id}`, body) : await api('POST', `/api/cars/${car.id}/dates`, body));
        carPage(car.id);
      } catch (err) { say(err.message); }
    });
    return f;
  }

  function datesBlock(car) {
    const mine = car.role === 'owner';
    const can = mine || car.role === 'editor';
    const box = h('section', { class: 'car-dates' });
    const act = async (method, url, body) => {
      try { Object.assign(car, await api(method, url, body)); carPage(car.id); } catch (err) { say(err.message); }
    };
    const rows = car.dates.map((d) => {
      const more = h('div', { class: 'car-actions hidden' });
      if (can) {
        more.append(
          h('button', { class: 'btn small', type: 'button', text: d.repeatMonths ? 'Renewed' : 'Done', onclick: () => act('POST', `/api/cars/${car.id}/dates/${d.id}/done`, {}) }),
          d.repeatMonths ? h('label', { class: 'car-pickday' }, h('span', { class: 'mono muted', text: 'or new date' }), h('input', { type: 'date', 'aria-label': 'New due date', onchange: (e) => e.target.value && act('POST', `/api/cars/${car.id}/dates/${d.id}/done`, { due: e.target.value }) })) : null,
          h('button', { class: 'btn small ghost', type: 'button', text: 'Snooze a week', onclick: () => act('POST', `/api/cars/${car.id}/dates/${d.id}/snooze`) }));
      }
      if (mine) {
        more.append(
          h('button', { class: 'btn small ghost', type: 'button', text: 'Edit', onclick: () => { fill(box, h('h3', { text: `Edit ${d.label}` }), dateForm(car, d)); } }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: () => act('DELETE', `/api/cars/${car.id}/dates/${d.id}`) }));
      }
      const row = h('button', { class: 'car-date', type: 'button', 'aria-expanded': 'false', onclick: () => { const open = more.classList.toggle('hidden') === false; row.setAttribute('aria-expanded', String(open)); } },
        h('span', { class: 'car-dlabel' }, h('b', { text: d.label }), h('span', { class: 'muted', text: `${niceDay(d.due)}${d.repeatMonths ? '' : ' · once'}${d.snoozedUntil ? ` · snoozed to ${niceDay(d.snoozedUntil)}` : ''}` })),
        pill(d.daysLeft));
      return h('div', { class: 'car-daterow' }, row, can ? more : null);
    });
    fill(box,
      h('div', { class: 'car-bar' }, h('h3', { text: 'Dates' }), mine ? h('button', { class: 'btn small ghost', type: 'button', text: 'Add a date', onclick: () => fill(box, h('h3', { text: 'Add a date' }), dateForm(car, null)) }) : null),
      rows.length ? rows : h('p', { class: 'muted', text: mine ? 'Add the MOT, tax, insurance and service dates and Roost will remind you.' : 'No dates yet.' }));
    return box;
  }


  // ---------- fill-ups and running costs ----------

  const TYPES = [['fuel', 'Fuel'], ['service', 'Service'], ['repair', 'Repair'], ['mot', 'MOT'], ['parts', 'Parts'], ['tyres', 'Tyres'], ['insurance', 'Insurance'], ['tax', 'Road tax'], ['parking', 'Parking'], ['wash', 'Wash'], ['fine', 'Fine'], ['other', 'Other']];
  const money = (p) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const km = (n) => (n == null ? '' : n.toLocaleString('en-GB'));
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: carry on without */ } },
  };
  const QUEUE = 'roost-cars-queue';
  const newCid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  // A fill-up typed with no signal waits on the phone and is sent when Roost is
  // reachable again. The cid makes a resend harmless on the server.
  async function flushQueue() {
    const queue = store.get(QUEUE, []);
    if (!queue.length) return 0;
    const left = [];
    let sent = 0;
    for (const q of queue) {
      try { await api('POST', `/api/cars/${q.carId}/entries`, { ...q.body, force: true }); sent++; } catch (err) { if (!err.status) left.push(q); }
    }
    store.set(QUEUE, left);
    return sent;
  }
  window.addEventListener('online', () => { flushQueue().then((n) => { if (n && S.current) carPage(S.current); }); });

  const HISTORY = new Set(['service', 'repair', 'mot', 'parts', 'tyres']);
  const GARAGE = new Set(['service', 'repair', 'mot', 'parts', 'tyres']);

  // A receipt photo is shrunk to a 2000px JPEG (a phone photo of a till roll
  // can be 8 MB); PDFs go as they are.
  async function toReceipt(file) {
    if (file.type === 'application/pdf') return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Couldn’t read that picture')); i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t read that picture'))), 'image/jpeg', 0.85));
    } finally { URL.revokeObjectURL(url); }
  }

  async function uploadFile(car, kind, entryId, file) {
    const blob = await toReceipt(file);
    const q = new URLSearchParams({ kind, name: file.name || '' });
    if (entryId) q.set('entry', entryId);
    const res = await fetch(`/api/cars/${car.id}/files?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'The file didn’t upload');
    return data;
  }

  function entryForm(car, existing, done) {
    const units = car.units === 'km' ? 'km' : 'mi';
    const f = h('form', { class: 'car-form car-entryform', autocomplete: 'off' });
    let type = existing ? existing.type : 'fuel';
    let result = existing ? existing.result : '';
    const chips = h('div', { class: 'car-chips', role: 'group', 'aria-label': 'What for' });
    const fuelBits = h('div', { class: 'car-fuelbits' });
    const jobBits = h('div', { class: 'car-fuelbits' });
    const motBits = h('div', { class: 'car-fuelbits' });
    const resultChips = h('div', { class: 'car-chips', role: 'group', 'aria-label': 'MOT result' });
    const paint = () => {
      fill(chips, TYPES.map(([v, t]) => h('button', { type: 'button', class: `car-chip${v === type ? ' on' : ''}`, 'aria-pressed': String(v === type), text: t, onclick: () => { type = v; paint(); } })));
      fill(resultChips, [['pass', 'Pass'], ['fail', 'Fail']].map(([v, t]) => h('button', { type: 'button', class: `car-chip${v === result ? ' on' : ''}`, 'aria-pressed': String(v === result), text: t, onclick: () => { result = result === v ? '' : v; paint(); } })));
      fuelBits.classList.toggle('hidden', type !== 'fuel');
      jobBits.classList.toggle('hidden', !GARAGE.has(type));
      motBits.classList.toggle('hidden', type !== 'mot');
    };
    const inp = (label, name, attrs = {}) => h('label', {}, h('span', { class: 'mono', text: label }), h('input', { name, autocomplete: 'off', ...attrs }));
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    fuelBits.append(
      inp('Litres', 'litres', { inputmode: 'decimal', value: existing && existing.litres ? existing.litres : '', placeholder: '38.4' }),
      h('label', { class: 'check-line' }, h('input', { type: 'checkbox', name: 'full', checked: existing ? existing.full : true }), ' Filled the tank'));
    jobBits.append(inp('Garage', 'garage', { maxlength: 60, value: existing ? existing.garage : '', placeholder: 'Who did it' }));
    motBits.append(h('div', {}, h('span', { class: 'mono muted', text: 'Result' }), resultChips),
      h('label', {}, h('span', { class: 'mono', text: 'Advisories' }), h('textarea', { name: 'advisories', maxlength: 500, rows: 2, text: existing ? existing.advisories : '', placeholder: 'What the tester noted' })));
    paint();
    const receipt = existing ? null : h('input', { type: 'file', name: 'receipt', accept: 'image/*,application/pdf' });
    const status = h('p', { class: 'car-warn', 'aria-live': 'polite' });
    f.append(chips, inp('Total (£)', 'amount', { inputmode: 'decimal', required: true, value: existing ? (existing.amount / 100).toFixed(2) : '', placeholder: '54.20' }), fuelBits, jobBits, motBits,
      inp(`Odometer (${units})`, 'odometer', { inputmode: 'numeric', value: existing && existing.odometer != null ? existing.odometer : '', placeholder: car.odometer ? `Last: ${km(car.odometer)}` : '41320' }),
      h('div', { class: 'car-two' }, inp('Date', 'date', { type: 'date', value: existing ? existing.date : today }), inp('Note', 'note', { maxlength: 500, value: existing ? existing.note : '', placeholder: 'What was done (optional)' })),
      receipt ? h('label', {}, h('span', { class: 'mono', text: 'Receipt (photo or PDF, optional)' }), receipt) : null,
      status,
      h('div', { class: 'car-actions' }, h('button', { class: 'btn', type: 'submit', text: existing ? 'Save' : 'Save entry' }), h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => done(false) })));
    let force = false;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const body = { type, date: d.date, amount: d.amount, odometer: d.odometer, note: d.note, litres: type === 'fuel' ? d.litres : '', full: type === 'fuel' ? f.elements.full.checked : false, garage: GARAGE.has(type) ? d.garage : '', result: type === 'mot' ? result : '', advisories: type === 'mot' ? d.advisories : '', force };
      if (!existing) body.cid = f.dataset.cid || (f.dataset.cid = newCid());
      try {
        let saved = null;
        if (existing) await api('PATCH', `/api/cars/${car.id}/entries/${existing.id}`, body);
        else saved = await api('POST', `/api/cars/${car.id}/entries`, body);
        const file = receipt && receipt.files[0];
        if (saved && file) {
          try { await uploadFile(car, 'receipt', saved.entry.id, file); } catch (err) { return done(true, `Saved, but the receipt didn’t upload: ${err.message}`); }
        }
        done(true);
      } catch (err) {
        if (err.code === 'check-odometer') {
          force = true;
          fill(status, `${err.message} Check it, or press Save again to keep it.`);
        } else if (!err.status && !existing && !(receipt && receipt.files[0])) {
          const queue = store.get(QUEUE, []);
          queue.push({ carId: car.id, body: { ...body, force: true } });
          store.set(QUEUE, queue);
          done(true, 'No signal: saved on this phone, and sent when Roost is reachable.');
        } else fill(status, err.message);
      }
    });
    return f;
  }

  function statTiles(car, stats) {
    const mode = store.get('roost-cars-consumption', car.units === 'km' ? 'l100' : 'mpg');
    const c = stats.overall;
    const per = car.units === 'km' ? 'km' : 'mile';
    const tile = (big, small, onclick) => h(onclick ? 'button' : 'div', { class: 'car-stat', type: onclick ? 'button' : null, onclick }, h('b', { text: big }), h('span', { class: 'mono muted', text: small }));
    return h('div', { class: 'car-stats' },
      tile(c ? String(mode === 'l100' ? c.l100 : c.mpg) : '–', c ? (mode === 'l100' ? 'L/100 km · tap' : 'mpg · tap') : 'needs 2 full tanks', c ? () => { store.set('roost-cars-consumption', mode === 'l100' ? 'mpg' : 'l100'); carPage(car.id); } : null),
      tile(stats.perUnit != null ? `${stats.perUnit}p` : '–', stats.perUnit != null ? `per ${per}, last year` : `per ${per}, needs miles`),
      tile(money(stats.thisMonth), 'this month'));
  }

  // ---------- history: export and print ----------

  const csvCell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  function exportCsv(car, entries) {
    const head = ['Date', 'Type', 'Garage', 'Odometer', 'Litres', 'Amount (GBP)', 'MOT result', 'Advisories', 'Note'];
    const rows = [...entries].reverse().map((e) => [e.date, e.label, e.garage, e.odometer ?? '', e.litres ?? '', (e.amount / 100).toFixed(2), e.result, e.advisories, e.note]);
    const blob = new Blob([[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${car.name} history.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // A tidy page for selling the car: the jobs in date order, printed or saved as PDF.
  function printHistory(car, entries) {
    const frame = h('iframe', { class: 'hidden', title: 'Service history' });
    document.body.append(frame);
    const doc = frame.contentDocument;
    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text != null) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const style = el('style', 'body{font:13px/1.45 Helvetica,Arial,sans-serif;color:#000;margin:24px}h1{font-size:22px;margin:0}p{margin:2px 0 14px;color:#444}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#555}');
    doc.head.append(style);
    doc.title = `${car.name} service history`;
    doc.body.append(el('h1', `${car.name}${car.plate ? ` · ${car.plate}` : ''}`), el('p', [car.make, car.model, car.year].filter(Boolean).join(' ') + ` · service history printed ${niceDay(new Date().toISOString().slice(0, 10))}`));
    const table = el('table');
    const hr = el('tr');
    for (const t of ['Date', 'What', 'Mileage', 'Garage', 'Details', 'Cost']) hr.append(el('th', t));
    table.append(hr);
    for (const e of [...entries].reverse()) {
      const tr = el('tr');
      tr.append(el('td', niceDay(e.date)), el('td', e.label + (e.result ? ` (${e.result})` : '')), el('td', e.odometer != null ? `${km(e.odometer)} ${car.units}` : ''), el('td', e.garage), el('td', [e.note, e.advisories && `Advisories: ${e.advisories}`].filter(Boolean).join(' · ')), el('td', money(e.amount)));
      table.append(tr);
    }
    doc.body.append(table);
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  }

  // ---------- the ledger: costs, history and papers ----------

  async function costsBlock(car) {
    const box = h('section', { class: 'car-costs' });
    const can = car.role === 'owner' || car.role === 'editor';
    const mine = car.role === 'owner';
    let data = null;
    const open = (title, el) => fill(box, h('div', { class: 'car-bar' }, h('h3', { text: title })), el);
    const finish = async (saved, msg) => { if (saved) { await load().catch(() => {}); carPage(car.id, msg || ''); } else paint(); };
    const reload = async () => { await load().catch(() => {}); carPage(car.id); };
    const add = () => open('Add an entry', entryForm(car, null, finish));
    const receiptsOf = (e) => (data.files || []).filter((x) => x.entryId === e.id);

    function entryRow(e, detailed) {
      const receipts = receiptsOf(e);
      const more = h('div', { class: `car-more${detailed ? '' : ' hidden'}` });
      if (e.type === 'mot' && (e.result || e.advisories)) more.append(h('p', { class: 'car-detail' }, e.result ? h('span', { class: `car-pill ${e.result === 'pass' ? '' : 'late'}`, text: e.result === 'pass' ? 'Pass' : 'Fail' }) : null, e.advisories ? ` Advisories: ${e.advisories}` : ''));
      if (detailed && e.note) more.append(h('p', { class: 'car-detail', text: e.note }));
      if (receipts.length) more.append(h('p', { class: 'car-detail' }, 'Receipts: ', receipts.map((x) => h('a', { class: 'car-link', href: `/api/cars/${car.id}/files/${x.id}`, target: '_blank', rel: 'noopener', text: x.name }))));
      if (e.canEdit) {
        const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', class: 'hidden', onchange: async (ev) => { const file = ev.target.files[0]; if (!file) return; say('Uploading…'); try { await uploadFile(car, 'receipt', e.id, file); say(''); await reload(); } catch (err) { say(err.message); } } });
        more.append(h('div', { class: 'car-actions' }, pick,
          h('button', { class: 'btn small ghost', type: 'button', text: 'Add receipt', onclick: () => pick.click() }),
          h('button', { class: 'btn small ghost', type: 'button', text: 'Edit', onclick: () => open('Edit entry', entryForm(car, e, finish)) }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: async () => { try { await api('DELETE', `/api/cars/${car.id}/entries/${e.id}`); await reload(); } catch (err) { say(err.message); } } })));
      }
      const title = e.label + (e.litres ? ` · ${e.litres} L` : '') + (e.garage ? ` · ${e.garage}` : '');
      const sub = [niceDay(e.date), e.odometer != null ? `${km(e.odometer)} ${car.units}` : '', e.by !== car.owner ? e.by : '', !detailed ? e.note : '', e.receipts ? `${e.receipts} receipt${e.receipts === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      const row = h('button', { class: 'car-date', type: 'button', 'aria-expanded': String(detailed), onclick: () => { const o = more.classList.toggle('hidden') === false; row.setAttribute('aria-expanded', String(o)); } },
        h('span', { class: 'car-dlabel' }, h('b', { text: title }), h('span', { class: 'muted', text: sub })), h('b', { text: money(e.amount) }));
      return h('div', { class: 'car-daterow' }, row, more);
    }

    function costsTab() {
      const shown = box.dataset.all ? data.entries : data.entries.slice(0, 8);
      return [
        shown.length ? shown.map((e) => entryRow(e, false)) : h('p', { class: 'muted', text: can ? 'Nothing logged yet. Add your first fill-up and Roost works out mpg and cost per mile.' : 'Nothing logged yet.' }),
        data.entries.length > 8 && !box.dataset.all ? h('button', { class: 'btn small ghost', type: 'button', text: `Show all ${data.count}`, onclick: () => { box.dataset.all = '1'; paint(); } }) : null,
      ];
    }

    function historyTab() {
      const jobs = data.entries.filter((e) => HISTORY.has(e.type));
      return [
        jobs.length ? h('div', { class: 'car-actions' },
          h('button', { class: 'btn small ghost', type: 'button', text: 'Export CSV', onclick: () => exportCsv(car, jobs) }),
          h('button', { class: 'btn small ghost', type: 'button', text: 'Print history', onclick: () => printHistory(car, jobs) })) : null,
        jobs.length ? h('div', { class: 'car-timeline' }, jobs.map((e) => entryRow(e, true))) : h('p', { class: 'muted', text: 'Services, repairs, MOTs, parts and tyres show up here. Add one under Costs and pick its type.' }),
      ];
    }

    function papersTab() {
      const papers = (data.files || []).filter((x) => x.kind === 'paper');
      const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', class: 'hidden', onchange: async (ev) => { const file = ev.target.files[0]; if (!file) return; say('Uploading…'); try { await uploadFile(car, 'paper', '', file); say(''); await reload(); } catch (err) { say(err.message); } } });
      return [
        h('p', { class: 'muted car-soon', text: 'The V5C, insurance schedule, MOT certificate. Kept in the owner’s Nest under Cars. Everyone this car is shared with can open them.' }),
        mine ? h('div', { class: 'car-actions' }, pick, h('button', { class: 'btn small', type: 'button', text: 'Add a document', onclick: () => pick.click() })) : null,
        papers.length ? papers.map((x) => h('div', { class: 'car-daterow' }, h('div', { class: 'car-date' },
          h('a', { class: 'car-link car-dlabel', href: `/api/cars/${car.id}/files/${x.id}`, target: '_blank', rel: 'noopener' }, h('b', { text: x.name }), h('span', { class: 'muted', text: `${niceDay(new Date(x.created).toISOString().slice(0, 10))} · ${Math.max(1, Math.round(x.size / 1024))} KB` })),
          mine ? h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: async () => { try { await api('DELETE', `/api/cars/${car.id}/files/${x.id}`); await reload(); } catch (err) { say(err.message); } } }) : null))) : h('p', { class: 'muted', text: 'No documents yet.' }),
      ];
    }

    function paint() {
      if (!data) return;
      const tab = S.tab || 'costs';
      const tabs = h('div', { class: 'car-chips', role: 'tablist', 'aria-label': 'Fuel, history and papers' }, [['costs', 'Costs'], ['history', 'History'], ['papers', 'Papers']].map(([v, t]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(v === tab), class: `car-chip${v === tab ? ' on' : ''}`, text: t, onclick: () => { S.tab = v; paint(); } })));
      fill(box, statTiles(car, data.stats),
        h('div', { class: 'car-bar' }, h('h3', { text: 'Fuel and costs' }), can ? h('button', { class: 'btn car-add', type: 'button', text: 'Add fill-up or cost', onclick: add }) : null),
        tabs, tab === 'costs' ? costsTab() : tab === 'history' ? historyTab() : papersTab());
    }
    fill(box, h('p', { class: 'muted mono', text: 'Loading…' }));
    try { data = await api('GET', `/api/cars/${car.id}/entries`); paint(); } catch (err) { fill(box, h('p', { class: 'muted', text: err.message })); }
    return box;
  }

  function carPage(id, notice) {
    const car = S.cars.find((c) => c.id === id);
    if (!car) { location.hash = '#/cars'; return; }
    S.current = id;
    document.title = car.name;
    const mine = car.role === 'owner';
    const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => e.target.files[0] && sendPhoto(car, e.target.files[0]) });
    const r = root();
    const costsHolder = h('div');
    fill(r, 
      h('div', { class: 'car-bar' }, h('a', { class: 'btn small ghost', href: '#/cars', 'aria-label': 'Back to cars', text: '‹' }), h('h2', { text: car.name }),
        car.archived ? h('span', { class: 'mono muted', text: 'Archived' }) : null),
      h('p', { class: 'car-say mono', id: 'cars-say', 'aria-live': 'polite' }),
      photo(car, 'car-photo car-hero'),
      mine ? h('div', { class: 'car-actions' }, file,
        h('button', { class: 'btn small', type: 'button', text: car.photo ? 'Change photo' : 'Add photo', onclick: () => file.click() }),
        S.glint ? h('button', { class: 'btn small ghost', type: 'button', text: 'From Glint', onclick: () => glintPicker(car) }) : null,
        car.photo ? h('button', { class: 'btn small ghost', type: 'button', text: 'Remove photo', onclick: async () => { try { Object.assign(car, await api('DELETE', `/api/cars/${car.id}/photo`)); carPage(id); } catch (err) { say(err.message); } } }) : null) : null,
      costsHolder,
      datesBlock(car),
      h('dl', { class: 'car-facts' },
        ...[['Plate', car.plate], ['Make and model', [car.make, car.model].filter(Boolean).join(' ')], ['Year', car.year], ['Fuel', car.fuel], ['Distance in', car.units === 'km' ? 'Kilometres' : 'Miles'], ['Owner', car.owner]]
          .filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { class: 'mono', text: k }), h('dd', { text: String(v) })])),
      h('p', { class: 'muted car-soon', text: 'Service history with receipts comes next.' }),
      mine ? h('details', { class: 'car-edit' }, h('summary', { class: 'mono', text: 'Edit details' }), form(car)) : null,
      mine ? sharePanel(car) : h('p', { class: 'muted', text: car.role === 'editor' ? 'Shared with you: you can add entries.' : 'Shared with you to look at.' }),
      mine ? h('div', { class: 'car-danger' },
        h('button', { class: 'btn small ghost', type: 'button', text: car.archived ? 'Bring back' : 'Archive (sold or gone)', onclick: async () => { try { Object.assign(car, await api('POST', `/api/cars/${car.id}/archive`, { on: !car.archived })); carPage(id); } catch (err) { say(err.message); } } }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Delete…', onclick: (e) => del(car, e.target.parentNode) })) : null,
    );
    costsBlock(car).then((b) => costsHolder.append(b));
    if (notice) say(notice);
  }

  // Deleting asks for the car's name on the page itself (no pop-up).
  function del(car, box) {
    const input = h('input', { 'aria-label': `Type ${car.name} to delete it`, placeholder: car.name, autocomplete: 'off' });
    const go = h('button', { class: 'btn small danger', type: 'submit', text: 'Delete for good' });
    const f = h('form', { class: 'car-confirm', onsubmit: (e) => {
      e.preventDefault();
      api('DELETE', `/api/cars/${car.id}`, { name: input.value }).then(async () => { await load(); location.hash = '#/cars'; }).catch((err) => say(err.message));
    } }, h('p', { class: 'muted', text: `This removes ${car.name} and everything logged for it. Type its name to confirm.` }), input, go,
    h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => f.remove() }));
    box.after(f);
    input.focus();
  }

  window.carsOpen = async (rest = [], opts = {}) => {
    const ticket = ++S.ask;
    S.glint = opts.glint === true;
    try {
      if (!S.loaded || !rest[0] || rest[0] === 'new') await load();
      else if (!S.cars.some((c) => c.id === rest[0])) await load();
    } catch (err) { if (ticket === S.ask) fill(root(), h('p', { text: err.message })); return; }
    if (ticket !== S.ask) return;
    flushQueue().then((n) => { if (n && S.current && rest[0] === S.current) carPage(S.current, `${n} saved entr${n === 1 ? 'y' : 'ies'} sent.`); });
    if (rest[0] === 'new') newCar();
    else if (rest[0]) carPage(rest[0]);
    else garage();
  };
})();
