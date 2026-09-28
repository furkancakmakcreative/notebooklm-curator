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

import { addSource } from '../src/notebooklm.js';

/**
 * Minimal stand-in for the add-source modal. `sources` is the list length;
 * typing into the modal field and pressing Enter grows it when `accepts`.
 */
function modalPage({ sources = 1, websitesOption = true, modalField = true, accepts = true } = {}) {
  const state = { sources, modalOpen: false, websitesClicked: false, typed: [], chatTyped: [] };
  const present = (sel) => {
    if (sel === '.cdk-overlay-backdrop') return state.modalOpen;
    return false;
  };
  const el = (count, actions = {}) => ({
    first: () => el(count, actions),
    last: () => el(count, actions),
    count: async () => count(),
    waitFor: async ({ state: want } = {}) => {
      if (want === 'detached' ? count() : !count()) throw new Error('timeout');
    },
    click: async () => actions.click?.(),
    fill: async (value) => actions.fill?.(value),
    press: async (key) => actions.press?.(key),
    locator: (sel) => (sel.includes('input') ? modalFieldEl() : el(() => 0)),
    getByText: () => el(() => (state.modalOpen && websitesOption ? 1 : 0), { click: () => { state.websitesClicked = true; } }),
  });
  let pendingUrl = null;
  const modalFieldEl = () =>
    el(() => (state.modalOpen && modalField && state.websitesClicked ? 1 : 0), {
      fill: (value) => { pendingUrl = value; state.typed.push(value); },
      press: (key) => { if (key === 'Enter' && accepts && pendingUrl) state.sources++; },
    });
  return {
    state,
    url: () => 'https://notebooklm.google.com/notebook/x',
    keyboard: { press: async (key) => { if (key === 'Escape') state.modalOpen = false; } },
    waitForTimeout: async () => {},
    $$eval: async (_sel, fn, cfg) => fn(Array.from({ length: state.sources }, () => ({ querySelector: () => null, innerText: 'Title' })), cfg),
    locator: (sel) => {
      if (sel === '.cdk-overlay-container') return el(() => (state.modalOpen ? 1 : 0));
      if (sel.includes('Add source')) return el(() => 1, { click: () => { state.modalOpen = true; } });
      return el(() => (present(sel) ? 1 : 0));
    },
  };
}

test('addSource types only into the modal field and confirms by the source count', async () => {
  const page = modalPage();
  const result = await addSource(page, 'https://example.com/a', { timeoutMs: 50 });
  assert.equal(result.added, true);
  assert.equal(result.submitted, true);
  assert.deepEqual([result.before, result.after], [1, 2]);
  assert.equal(page.state.modalOpen, false, 'the modal is closed afterwards');
});

test('addSource never types the link anywhere when the Websites option is missing', async () => {
  const page = modalPage({ websitesOption: false });
  const result = await addSource(page, 'https://example.com/a', { timeoutMs: 50 });
  assert.equal(result.added, false);
  assert.equal(result.submitted, false);
  assert.match(result.reason, /Websites/);
  assert.deepEqual(page.state.typed, []);
});

test('an unconfirmed but submitted link is reported as submitted, so it is not blindly retried', async () => {
  const page = modalPage({ accepts: false });
  const result = await addSource(page, 'https://example.com/a', { timeoutMs: 50 });
  assert.equal(result.added, false);
  assert.equal(result.submitted, true);
  assert.match(result.reason, /Check the notebook before adding it again/);
});
