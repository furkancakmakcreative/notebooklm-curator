import assert from 'node:assert/strict';
import test from 'node:test';

import { NotSignedInError, gotoHome, gotoNotebook } from '../src/notebooklm.js';

function fakePage(startUrl, redirectTo) {
  const visits = [];
  let url = startUrl;
  return {
    visits,
    url: () => url,
    async goto(target) {
      visits.push(target);
      url = redirectTo ?? target;
    },
    getByRole: () => ({ first: () => ({ waitFor: async () => { throw new Error('none'); } }) }),
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
  };
}

test('never navigates away from a Google sign-in page someone may be using', async () => {
  const page = fakePage('https://accounts.google.com/v3/signin/identifier?continue=x');
  await assert.rejects(gotoHome(page), NotSignedInError);
  await assert.rejects(gotoNotebook(page, '00000000-0000-0000-0000-000000000000'), /Run nlm_auth/);
  assert.deepEqual(page.visits, []);
});

test('a signed-out profile fails with a clear nlm_auth hint instead of a timeout', async () => {
  const page = fakePage('about:blank', 'https://accounts.google.com/ServiceLogin?continue=x');
  await assert.rejects(gotoHome(page), /Not signed in.*nlm_auth/);
  assert.deepEqual(page.visits, ['https://notebooklm.google.com/']);
});
