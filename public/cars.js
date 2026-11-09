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
      h('div', { class: 'car-info' }, h('b', { text: car.name }), h('span', { class: 'muted', text: sub || [car.make, car.model].filter(Boolean).join(' ') || ' ' })));
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
      h('p', { class: 'muted car-soon', text: 'Dates, fuel and service history come next.' }),
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
