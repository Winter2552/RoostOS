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
  constructor({ store, dir, hasApp, userExists }) {
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
    };
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

module.exports = { Cars, cleanPlate, FUELS };
