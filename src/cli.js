'use strict';

// Fixes that need the server's own command line, for when nobody can sign in
// as an admin. On ZimaOS:
//   docker exec roost node src/cli.js reset-two-step <username>
//   docker restart roost

const path = require('path');
const { Store } = require('./store');

const [command, username] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

if (command !== 'reset-two-step' || !username) {
  console.log('Usage: node src/cli.js reset-two-step <username>');
  process.exit(1);
}

const store = new Store(dataDir);
const user = store.db.users.find((u) => u.username === username.toLowerCase());
if (!user) {
  console.error(`No user called ${username}`);
  process.exit(1);
}
delete user.twoStep;
user.trusted = [];
store.save();
console.log(`Two-step sign-in is off for ${user.username}. Restart Roost (docker restart roost), then sign in with just the password and set it up again.`);
