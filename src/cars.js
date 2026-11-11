'use strict';

// Car log: every car one person (or a household) looks after.
//
// Cars are private to their owner. The owner can share one with named people
// as a viewer (read) or an editor (adds fill-ups and costs, later), or switch
// on Household so everyone who has the Cars app sees it. Admins get no
// automatic way in. Cars live in the same JSON store as the rest of Roost; a
// car's photo is one small JPEG file next to it. Nothing here runs on a timer.

const fs = require('fs');
const path = require('path');
const { HttpError, str } = require('./http');

const MAX_PHOTO = 600 * 1024;
const FUELS = ['petrol', 'diesel', 'hybrid', 'electric', 'other'];
const UNITS = ['mi', 'km'];
const ROLES = ['viewer', 'editor'];
const MAX_CARS = 40;
const MAX_DATES = 30;
const KINDS = { mot: 'MOT', tax: 'Road tax', insurance: 'Insurance', service: 'Service', cover: 'Breakdown cover', custom: 'Other' };
const DEFAULT_LEADS = [30, 7, 0];
const SNOOZE_DAYS = 7;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Days are plain "YYYY-MM-DD" strings in Roost's time zone; no clock times.
const dayMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const daysBetween = (from, to) => Math.round((dayMs(to) - dayMs(from)) / 86400000);
const addDays = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);

function validDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
  const t = new Date(dayMs(v));
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== v || +v.slice(0, 4) < 2000 || +v.slice(0, 4) > 2100 ? null : v;
}

// 31 Jan + 1 month is 28 Feb, not 3 Mar.
function addMonths(d, n) {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12 + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, Math.min(+d.slice(8, 10), last)));
  return t.toISOString().slice(0, 10);
}

function cleanLeads(v) {
  if (!Array.isArray(v)) return DEFAULT_LEADS;
  const out = [...new Set(v.map((n) => num(n, 0, 365)).filter((n) => n !== null))].sort((a, b) => b - a).slice(0, 4);
  return out.length ? out : DEFAULT_LEADS;
}

const dayText = (days) => (days < 0 ? `overdue by ${-days} day${days === -1 ? '' : 's'}` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} days`);

const num = (v, lo, hi) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};

// A plate is shown in capitals with single spaces: "ab12  cde" -> "AB12 CDE".
function cleanPlate(raw) {
  return str(raw, 12).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

class Cars {
  // hasApp(user) says whether a person has the Cars app switched on; it is how
  // Household and every request are kept to people who are allowed in.
  constructor({ store, dir, hasApp, userExists, today = () => new Date().toISOString().slice(0, 10) }) {
    this.today = today;
    this.store = store;
    this.dir = dir;
    this.hasApp = hasApp;
    this.userExists = userExists;
  }

  all() {
    if (!Array.isArray(this.store.db.cars)) this.store.db.cars = [];
    return this.store.db.cars;
  }

  photoFile(id) {
    return path.join(this.dir, `${id}.jpg`);
  }

  // 'owner', 'editor', 'viewer', or null for no access at all (admins too).
  roleOf(user, car) {
    if (!user || user.role === 'guest' || !this.hasApp(user)) return null;
    if (car.ownerId === user.id) return 'owner';
    const share = (car.shares || []).find((s) => s.userId === user.id);
    if (share) return share.role;
    return car.household ? 'viewer' : null;
  }

  // The car if this person may see it, otherwise "not found" (so a car's
  // existence isn't revealed to someone it isn't shared with).
  get(user, id, need = 'viewer') {
    const car = this.all().find((c) => c.id === id);
    const role = car && this.roleOf(user, car);
    if (!role) throw new HttpError(404, 'That car isn’t there');
    const rank = { viewer: 0, editor: 1, owner: 2 };
    if (rank[role] < rank[need]) throw new HttpError(403, need === 'owner' ? 'Only the owner can do that' : 'You can only look at this car');
    return car;
  }

  view(user, car) {
    const role = this.roleOf(user, car);
    const out = {
      id: car.id, name: car.name, plate: car.plate, make: car.make, model: car.model, year: car.year,
      fuel: car.fuel, units: car.units, household: car.household === true, archived: Boolean(car.archivedAt),
      photo: fs.existsSync(this.photoFile(car.id)) ? `/api/cars/${car.id}/photo?v=${car.photoAt || 0}` : '',
      role, owner: this.nameOf(car.ownerId),
      dates: this.datesView(car),
    };
    out.next = out.dates[0] ? { label: out.dates[0].label, daysLeft: out.dates[0].daysLeft } : null;
    if (role === 'owner') {
      out.shares = (car.shares || []).filter((s) => this.userExists(s.userId)).map((s) => ({ userId: s.userId, name: this.nameOf(s.userId), role: s.role }));
    }
    return out;
  }

  nameOf(userId) {
    const u = this.store.db.users.find((x) => x.id === userId);
    return u ? (u.displayName || u.username) : 'Someone';
  }

  list(user) {
    return this.all()
      .filter((c) => this.roleOf(user, c))
      .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.created - b.created)
      .map((c) => this.view(user, c));
  }

  // The fields a person can type, cleaned. Missing ones keep `base`.
  fields(body, base = {}) {
    const out = { ...base };
    if ('name' in body) {
      out.name = str(body.name, 40);
      if (!out.name) throw new HttpError(400, 'Give the car a name');
    }
    if ('plate' in body) out.plate = cleanPlate(body.plate);
    if ('make' in body) out.make = str(body.make, 30);
    if ('model' in body) out.model = str(body.model, 30);
    if ('year' in body) {
      out.year = body.year === '' || body.year == null ? null : num(body.year, 1900, new Date().getFullYear() + 1);
      if (out.year === null && body.year !== '' && body.year != null) throw new HttpError(400, 'That year doesn’t look right');
    }
    if ('fuel' in body) {
      if (!FUELS.includes(body.fuel)) throw new HttpError(400, 'Pick a fuel type');
      out.fuel = body.fuel;
    }
    if ('units' in body) {
      if (!UNITS.includes(body.units)) throw new HttpError(400, 'Pick miles or kilometres');
      out.units = body.units;
    }
    if ('household' in body) out.household = body.household === true;
    return out;
  }

  create(user, body) {
    if (user.role === 'guest' || !this.hasApp(user)) throw new HttpError(403, 'Cars aren’t on for you');
    if (this.all().filter((c) => c.ownerId === user.id).length >= MAX_CARS) throw new HttpError(400, 'That’s a lot of cars; archive one first');
    const car = {
      id: this.store.newId(), ownerId: user.id, created: Date.now(), shares: [], household: false,
      name: '', plate: '', make: '', model: '', year: null, fuel: 'petrol', units: 'mi',
      ...this.fields({ ...body, name: body.name ?? '' }),
    };
    this.all().push(car);
    this.store.save();
    return this.view(user, car);
  }

  update(user, id, body) {
    const car = this.get(user, id, 'owner');
    Object.assign(car, this.fields(body, car));
    this.store.save();
    return this.view(user, car);
  }

  // Shares replace the whole list: [{ userId, role }]. Only people with the app
  // can be added, never the owner, and never twice.
  setShares(user, id, list) {
    const car = this.get(user, id, 'owner');
    if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of people');
    const seen = new Set([user.id]);
    const shares = [];
    for (const s of list) {
      if (!s || seen.has(s.userId) || !ROLES.includes(s.role)) continue;
      const target = this.store.db.users.find((u) => u.id === s.userId);
      if (!target || target.role === 'guest' || !this.hasApp(target)) continue;
      seen.add(s.userId);
      shares.push({ userId: s.userId, role: s.role });
    }
    car.shares = shares;
    this.store.save();
    return this.view(user, car);
  }

  archive(user, id, on) {
    const car = this.get(user, id, 'owner');
    if (on) car.archivedAt = Date.now();
    else delete car.archivedAt;
    this.store.save();
    return this.view(user, car);
  }

  // Deleting asks for the car's name, so a stray tap can't lose its history.
  remove(user, id, confirmName) {
    const car = this.get(user, id, 'owner');
    if (str(confirmName, 40).toLowerCase() !== car.name.toLowerCase()) throw new HttpError(400, 'Type the car’s name to delete it');
    this.drop(car);
    this.store.save();
  }

  drop(car) {
    this.store.db.cars = this.all().filter((c) => c.id !== car.id);
    fs.rmSync(this.photoFile(car.id), { force: true });
  }

  // A person was deleted: their cars go with them, and their shares are removed.
  forgetUser(userId) {
    for (const car of this.all().filter((c) => c.ownerId === userId)) this.drop(car);
    for (const car of this.all()) car.shares = (car.shares || []).filter((s) => s.userId !== userId);
  }


  // ---------- dates (MOT, tax, insurance, service, ...) ----------

  live(car) {
    return (car.dates || []).filter((d) => !d.doneAt);
  }

  datesView(car) {
    const today = this.today();
    return this.live(car)
      .map((d) => ({ id: d.id, kind: d.kind, label: d.label, due: d.due, daysLeft: daysBetween(today, d.due), leads: d.leads, repeatMonths: d.repeatMonths, snoozedUntil: d.snoozedUntil && d.snoozedUntil > today ? d.snoozedUntil : '', lastDone: d.lastDone || '' }))
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  dateFields(body, base = {}) {
    const out = { ...base };
    if ('kind' in body) {
      if (!(body.kind in KINDS)) throw new HttpError(400, 'Pick what kind of date it is');
      out.kind = body.kind;
    }
    if ('label' in body || !out.label) out.label = str(body.label, 40) || KINDS[out.kind || 'custom'];
    if ('due' in body) {
      out.due = validDay(body.due);
      if (!out.due) throw new HttpError(400, 'That date doesn’t look right');
    }
    if (!out.due) throw new HttpError(400, 'Pick the date it is due');
    if ('leads' in body) out.leads = cleanLeads(body.leads);
    else if (!out.leads) out.leads = DEFAULT_LEADS;
    if ('repeatMonths' in body) {
      const n = body.repeatMonths === '' || body.repeatMonths == null ? 0 : num(body.repeatMonths, 0, 120);
      if (n === null) throw new HttpError(400, 'Repeat every how many months?');
      out.repeatMonths = n;
    } else if (out.repeatMonths == null) out.repeatMonths = out.kind === 'custom' || out.kind === 'service' ? 0 : 12;
    if ('due' in body) { out.notified = []; delete out.snoozedUntil; }
    if ('leads' in body) out.notified = [];
    return out;
  }

  addDate(user, id, body) {
    const car = this.get(user, id, 'owner');
    if (!Array.isArray(car.dates)) car.dates = [];
    if (this.live(car).length >= MAX_DATES) throw new HttpError(400, 'That’s plenty of dates; remove one first');
    car.dates.push(this.dateFields({ kind: 'custom', ...body }, { id: this.store.newId(), notified: [] }));
    this.store.save();
    return this.view(user, car);
  }

  findDate(car, did) {
    const d = this.live(car).find((x) => x.id === did);
    if (!d) throw new HttpError(404, 'That date isn’t there');
    return d;
  }

  updateDate(user, id, did, body) {
    const car = this.get(user, id, 'owner');
    const d = this.findDate(car, did);
    Object.assign(d, this.dateFields(body, d));
    this.store.save();
    return this.view(user, car);
  }

  removeDate(user, id, did) {
    const car = this.get(user, id, 'owner');
    this.findDate(car, did);
    car.dates = car.dates.filter((x) => x.id !== did);
    this.store.save();
    return this.view(user, car);
  }

  // "Done, renewed": a repeating date moves on (a new date can be typed in);
  // a one-off is finished and drops off the list.
  doneDate(user, id, did, body = {}) {
    const car = this.get(user, id, 'editor');
    const d = this.findDate(car, did);
    const today = this.today();
    let next = null;
    if (body.due) {
      next = validDay(body.due);
      if (!next) throw new HttpError(400, 'That date doesn’t look right');
    } else if (d.repeatMonths) {
      // Renewing early keeps the anniversary; renewing late counts from today.
      next = addMonths(d.due >= today ? d.due : today, d.repeatMonths);
    }
    if (next) {
      d.due = next;
      d.notified = [];
      d.lastDone = today;
      delete d.snoozedUntil;
    } else {
      d.doneAt = today;
    }
    this.store.save();
    return this.view(user, car);
  }

  snoozeDate(user, id, did) {
    const car = this.get(user, id, 'editor');
    this.findDate(car, did).snoozedUntil = addDays(this.today(), SNOOZE_DAYS);
    this.store.save();
    return this.view(user, car);
  }

  // Everyone who should hear about a car's dates: the owner, the people it is
  // shared with, and (with Household) everyone who has the app.
  audience(car) {
    const ids = new Set([car.ownerId, ...(car.shares || []).map((s) => s.userId)]);
    if (car.household) for (const u of this.store.db.users) ids.add(u.id);
    return [...ids].filter((uid) => {
      const u = this.store.db.users.find((x) => x.id === uid);
      return u && u.role !== 'guest' && this.hasApp(u);
    });
  }

  // Run once a day. Works out which dates have reached a lead time they
  // haven't been told about, marks them told, and returns the messages to
  // send. A date that is 5 days away when first added is told once, not twice.
  // Overdue dates are not repeated; they stay red in the app.
  remind(today = this.today()) {
    const out = [];
    for (const car of this.all()) {
      if (car.archivedAt) continue;
      const to = this.audience(car);
      for (const d of this.live(car)) {
        if (d.snoozedUntil && d.snoozedUntil > today) continue;
        const left = daysBetween(today, d.due);
        const told = new Set(d.notified || []);
        const reached = d.leads.filter((n) => left <= n && !told.has(n));
        if (!reached.length) continue;
        d.notified = [...told, ...reached];
        if (left < -1) continue; // missed by days (the server was off): the app shows it, no stale push
        out.push({ carId: car.id, dateId: d.id, userIds: to, title: `${car.name}: ${d.label}`, body: `${d.label} is ${dayText(left)} (${d.due.split('-').reverse().join('/')})`, tag: `car-${d.id}-${d.due}`, url: `/#/cars/${car.id}` });
      }
    }
    if (out.length) this.store.save();
    return out;
  }

  // The app was switched off for someone (or removed): shares to them stay
  // stored but roleOf already hides the cars until it is back on.

  setPhoto(user, id, buf) {
    const car = this.get(user, id, 'owner');
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.length > MAX_PHOTO || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      throw new HttpError(400, 'Send a JPEG photo under 600 KB');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.photoFile(id), buf);
    car.photoAt = Date.now();
    this.store.save();
    return this.view(user, car);
  }

  photo(user, id) {
    this.get(user, id);
    const file = this.photoFile(id);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  removePhoto(user, id) {
    const car = this.get(user, id, 'owner');
    fs.rmSync(this.photoFile(id), { force: true });
    delete car.photoAt;
    this.store.save();
    return this.view(user, car);
  }
}

module.exports = { Cars, cleanPlate, FUELS, KINDS, daysBetween, addMonths, addDays, validDay, dayText };
