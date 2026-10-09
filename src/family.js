'use strict';

// Family: one shared space in Nest that every family member can open, add to
// and tidy, with its own storage limit so shared files don't eat into anyone's
// personal space. The admin picks the members under Admin → Family.
//
// The family record doubles as the owner Nest stores the files under, so Nest
// needs no special cases: its files live at <NEST_DIR>/Family_family/...

const FAMILY_ID = 'family';
const DEFAULT_FAMILY_GB = 100;

// The family record, made on first use. Members are user ids.
function familyOf(db) {
  if (!db.family) {
    db.family = { id: FAMILY_ID, username: 'Family', members: [], limitGb: DEFAULT_FAMILY_GB, storageUsage: {} };
  }
  return db.family;
}

function isMember(db, user) {
  return Boolean(db.family && db.family.members.includes(user.id));
}

// Only ids of real users, each once, in the order given.
function cleanMembers(db, ids) {
  if (!Array.isArray(ids)) return null;
  const known = new Set(db.users.map((u) => u.id));
  return [...new Set(ids.filter((id) => typeof id === 'string' && known.has(id)))];
}

module.exports = { FAMILY_ID, DEFAULT_FAMILY_GB, familyOf, isMember, cleanMembers };
