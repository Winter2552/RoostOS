'use strict';

// Car log's optional DVLA lookup. Off until an admin saves a free key from the
// DVLA's Vehicle Enquiry Service. It only runs when someone presses "Check with
// DVLA" on a car: one request, only the number plate is sent (in the body, as
// the DVLA asks), and the answer is a suggestion the person confirms. Nothing
// is refreshed in the background and nothing about the answer is kept.

const BASE = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const TIMEOUT_MS = 8000;
const KEY_RE = /^[A-Za-z0-9]{20,80}$/;

class DvlaError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DvlaError';
    this.status = status;
  }
}

// "ab12 cde" -> "AB12CDE"; null if it can't be a plate.
function cleanPlate(raw) {
  const p = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return p.length >= 2 && p.length <= 8 ? p : null;
}

const FUELS = { PETROL: 'petrol', DIESEL: 'diesel', ELECTRICITY: 'electric', 'HYBRID ELECTRIC': 'hybrid' };
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const text = (v, max = 40) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The few fields Roost uses, tidied. Names are in Roost's style.
function readVehicle(v) {
  const o = v && typeof v === 'object' ? v : {};
  const year = Number.isInteger(o.yearOfManufacture) && o.yearOfManufacture > 1900 && o.yearOfManufacture < 2100 ? o.yearOfManufacture : null;
  return {
    make: text(o.make).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()),
    colour: text(o.colour).toLowerCase().replace(/^./, (c) => c.toUpperCase()),
    year,
    fuel: FUELS[text(o.fuelType).toUpperCase()] || (text(o.fuelType) ? 'other' : ''),
    tax: { status: text(o.taxStatus), due: day(o.taxDueDate) },
    // The DVLA's own docs show motExpiry in the example and motExpiryDate in the spec: take either.
    mot: { status: text(o.motStatus), due: day(o.motExpiryDate) || day(o.motExpiry) },
  };
}

async function lookup({ key, plate, base = BASE, fetchImpl = fetch }) {
  const vrn = cleanPlate(plate);
  if (!vrn) throw new DvlaError(400, 'Add the car’s number plate first');
  let res;
  try {
    res = await fetchImpl(base, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ registrationNumber: vrn }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new DvlaError(502, 'Couldn’t reach the DVLA. Try again in a minute');
  }
  if (res.status === 404) throw new DvlaError(404, 'The DVLA has no car with that number plate');
  if (res.status === 400) throw new DvlaError(400, 'The DVLA didn’t accept that number plate');
  if (res.status === 401 || res.status === 403) throw new DvlaError(502, 'The DVLA refused the key. Check it in Admin → Server');
  if (res.status === 429) throw new DvlaError(429, 'The DVLA is busy. Try again in a minute');
  if (!res.ok) throw new DvlaError(502, 'The DVLA had a problem. Try again later');
  let body;
  try { body = await res.json(); } catch { throw new DvlaError(502, 'The DVLA sent something Roost couldn’t read'); }
  return readVehicle(body);
}

module.exports = { lookup, readVehicle, cleanPlate, DvlaError, KEY_RE, BASE };
