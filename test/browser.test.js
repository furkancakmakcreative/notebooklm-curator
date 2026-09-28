import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nlm-browser-test-'));
process.env.NLM_BROWSER_CHANNEL = 'chromium'; // skip the real-Chrome check

const browser = await import('../src/browser.js');

/** A launcher that, like Chrome, refuses a profile that is already open. */
function fakeChromium({ failFirst = false } = {}) {
  const open = new Set();
  const launches = [];
  let failed = !failFirst;
  return {
    launches,
    open,
    async launchPersistentContext(dir, opts) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!failed) {
        failed = true;
        throw new Error('transient launch failure');
      }
      if (open.has(dir)) throw new Error(`profile in use: ${dir}`);
      open.add(dir);
      launches.push(opts.headless);
      const ctx = new EventEmitter();
      ctx.pages = () => [];
      ctx.newPage = async () => ({});
      ctx.close = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        open.delete(dir);
        ctx.emit('close');
      };
      return ctx;
    },
  };
}

test.afterEach(async () => {
  await browser.closeBrowser();
});

test('a sign-in request replaces a background browser without a second Chrome on the profile', async () => {
  const chromium = fakeChromium();
  browser._setChromiumForTests(chromium);
  const account = 'race';
  const background = await browser.getContext({ account });
  assert.equal(background.__headless, true);

  const results = await Promise.all([
    browser.getContext({ account, headless: false }),
    browser.getContext({ account, headless: false }),
    browser.getContext({ account }),
  ]);
  assert.equal(results[0], results[1]);
  assert.equal(results[0], results[2], 'a background caller reuses the visible window');
  assert.equal(results[0].__headless, false);
  assert.deepEqual(chromium.launches, [true, false]);
  assert.equal(chromium.open.size, 1);
});

test('closing an account lets the next call relaunch in the background', async () => {
  const chromium = fakeChromium();
  browser._setChromiumForTests(chromium);
  const visible = await browser.getContext({ account: 'close', headless: false });
  const [, next] = await Promise.all([
    browser.closeAccount('close'),
    browser.getContext({ account: 'close' }),
  ]);
  assert.notEqual(next, visible);
  assert.equal(next.__headless, true);
  assert.equal(chromium.open.size, 1);
});

test('a failed launch does not poison the account', async () => {
  const chromium = fakeChromium({ failFirst: true });
  browser._setChromiumForTests(chromium);
  await assert.rejects(browser.getContext({ account: 'retry' }), /transient/);
  const ctx = await browser.getContext({ account: 'retry' });
  assert.equal(ctx.__headless, true);
});
