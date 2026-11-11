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
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
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
    const sub = [car.plate, car.role !== 'owner' ? `${car.owner}’s car` : car.household ? 'Household' : car.shares && car.shares.length ? `Shared with ${car.shares.length}` : ''].filter(Boolean).join(' · ');
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

  function carPage(id) {
    const car = S.cars.find((c) => c.id === id);
    if (!car) { location.hash = '#/cars'; return; }
    document.title = car.name;
    const mine = car.role === 'owner';
    const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => e.target.files[0] && sendPhoto(car, e.target.files[0]) });
    const r = root();
    fill(r, 
      h('div', { class: 'car-bar' }, h('a', { class: 'btn small ghost', href: '#/cars', 'aria-label': 'Back to cars', text: '‹' }), h('h2', { text: car.name }),
        car.archived ? h('span', { class: 'mono muted', text: 'Archived' }) : null),
      h('p', { class: 'car-say mono', id: 'cars-say', 'aria-live': 'polite' }),
      photo(car, 'car-photo car-hero'),
      mine ? h('div', { class: 'car-actions' }, file,
        h('button', { class: 'btn small', type: 'button', text: car.photo ? 'Change photo' : 'Add photo', onclick: () => file.click() }),
        S.glint ? h('button', { class: 'btn small ghost', type: 'button', text: 'From Glint', onclick: () => glintPicker(car) }) : null,
        car.photo ? h('button', { class: 'btn small ghost', type: 'button', text: 'Remove photo', onclick: async () => { try { Object.assign(car, await api('DELETE', `/api/cars/${car.id}/photo`)); carPage(id); } catch (err) { say(err.message); } } }) : null) : null,
      h('dl', { class: 'car-facts' },
        ...[['Plate', car.plate], ['Make and model', [car.make, car.model].filter(Boolean).join(' ')], ['Year', car.year], ['Fuel', car.fuel], ['Distance in', car.units === 'km' ? 'Kilometres' : 'Miles'], ['Owner', car.owner]]
          .filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { class: 'mono', text: k }), h('dd', { text: String(v) })])),
      datesBlock(car),
      h('p', { class: 'muted car-soon', text: 'Fuel and service history come next.' }),
      mine ? h('details', { class: 'car-edit' }, h('summary', { class: 'mono', text: 'Edit details' }), form(car)) : null,
      mine ? sharePanel(car) : h('p', { class: 'muted', text: car.role === 'editor' ? 'Shared with you: you can add entries.' : 'Shared with you to look at.' }),
      mine ? h('div', { class: 'car-danger' },
        h('button', { class: 'btn small ghost', type: 'button', text: car.archived ? 'Bring back' : 'Archive (sold or gone)', onclick: async () => { try { Object.assign(car, await api('POST', `/api/cars/${car.id}/archive`, { on: !car.archived })); carPage(id); } catch (err) { say(err.message); } } }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Delete…', onclick: (e) => del(car, e.target.parentNode) })) : null,
    );
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
    if (rest[0] === 'new') newCar();
    else if (rest[0]) carPage(rest[0]);
    else garage();
  };
})();
