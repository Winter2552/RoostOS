'use strict';

// Shared by the test files. Admins must set up two-step sign-in before admin
// pages work, so tests that need an admin turn it on first.

const twoStep = require('../src/twostep');

async function setUpTwoStep(call, cookie) {
  const start = await call('POST', '/api/me/two-step/start', null, cookie);
  const on = await call('POST', '/api/me/two-step/enable', { code: twoStep.codeAt(start.body.secret, twoStep.currentStep()) }, cookie);
  if (on.status !== 200) throw new Error(`Two-step setup failed: ${on.status}`);
  return start.body.secret;
}

// A valid code that hasn't been used yet: the next step is accepted too.
function freshCode(secret) {
  return twoStep.codeAt(secret, twoStep.currentStep() + 1);
}

module.exports = { setUpTwoStep, freshCode };
