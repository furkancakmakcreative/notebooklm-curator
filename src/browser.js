/**
 * Browser lifecycle. One persistent Chrome profile per account, so the
 * Google login happens once and every later run reuses the cookies.
 *
 * We never store a password. Only the browser profile directory, which
 * lives on this machine under the OS app-data path.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const _contexts = new Map(); // account -> { ctx } | { pending }
let _chromium = null;

/**
 * Prefer patchright (a Playwright fork with anti-detection patches);
 * fall back to stock playwright if it is not installed.
 */
async function loadChromium() {
  if (_chromium) return _chromium;
  try {
    ({ chromium: _chromium } = await import('patchright'));
  } catch {
    ({ chromium: _chromium } = await import('playwright'));
  }
  return _chromium;
}

/** Test hook: swap in a fake launcher. Not part of the public API. */
export function _setChromiumForTests(chromium) {
  _chromium = chromium;
}

/**
 * This tool intentionally launches real Google Chrome (channel: 'chrome'),
 * not a downloaded/bundled Chromium build — patchright's anti-detection
 * patches are far more convincing against NotebookLM's bot checks when the
 * automation runs inside an actual Chrome install. Trading that away for a
 * bundled-Chromium default would make the tool less reliable at the one
 * thing it exists to do, so instead we fail fast with a clear message when
 * Chrome is missing rather than silently degrading detection resistance.
 */
const CHROME_PATHS = {
  win32: [
    `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};

/**
 * true / false on Windows and macOS; null on platforms we don't list
 * (e.g. Linux), where Playwright's own launch error is left to surface.
 */
export function chromeInstalled() {
  const candidates = CHROME_PATHS[process.platform];
  if (!candidates) return null;
  return candidates.some((p) => p && fs.existsSync(p));
}

/** Best-effort check so a missing Chrome install fails with a clear message. */
function assertChromeInstalled() {
  if (chromeInstalled() !== false) return;
  throw new Error(
    'Google Chrome was not found. This tool automates your real Chrome install ' +
      '(not a downloaded Chromium) so it stays undetected by NotebookLM — install ' +
      'Chrome from https://www.google.com/chrome/ and try again.',
  );
}

/** Profile slugs become directory names — keep them to a safe, flat charset. */
function assertSafeAccount(account) {
  if (!/^[a-zA-Z0-9_-]+$/.test(account)) {
    throw new Error(
      `invalid account name "${account}": only letters, digits, "-" and "_" are allowed`,
    );
  }
}

export function profileDir(account = 'default') {
  assertSafeAccount(account);
  const base =
    process.env.NLM_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'notebooklm-curator')
      : path.join(os.homedir(), '.local', 'share', 'notebooklm-curator'));
  const dir = path.join(base, 'accounts', account, 'chrome_profile');
  // 0o700: this directory ends up holding a live Google session cookie —
  // keep it unreadable to other local users on shared/multi-user machines.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * @param {object} opts
 * @param {boolean} opts.headless  false shows the window (needed for login)
 * @param {string}  opts.account   profile slug, for multiple Google accounts
 */
export async function getContext({ headless = true, account = 'default' } = {}) {
  // Each pass either returns a usable context or waits for a state change
  // (a launch or a close finishing) and looks again.
  for (;;) {
    const entry = _contexts.get(account);
    if (entry?.closing) {
      await entry.closing;
      continue;
    }
    const ctx = entry?.pending ? await entry.pending : entry?.ctx;
    if (ctx && !ctx.__closed) {
      // A caller that needs a visible window (sign-in) must not be handed a
      // background browser that another call launched first. That is how
      // "the window opened" could be reported while nothing appeared.
      if (!headless && ctx.__headless) {
        await closeAccount(account);
        continue;
      }
      return ctx;
    }
    if (entry && _contexts.get(account) === entry) _contexts.delete(account);
    if (!_contexts.get(account)) break;
  }

  // Two overlapping tool calls at cold start must not both launch a Chrome
  // process against the same profile dir: stash the in-flight promise so a
  // concurrent caller awaits the same launch instead of racing it.
  const slot = {};
  slot.pending = (async () => {
    // Yield first so a synchronous throw below still leaves this slot in
    // place for the catch block to clear (otherwise a missing Chrome would
    // poison the account until restart).
    await null;
    try {
      if (!process.env.NLM_BROWSER_CHANNEL) assertChromeInstalled();
      const chromium = await loadChromium();
      const ctx = await chromium.launchPersistentContext(profileDir(account), {
        headless,
        channel: process.env.NLM_BROWSER_CHANNEL || 'chrome',
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      ctx.__closed = false;
      ctx.__headless = headless;
      ctx.on('close', () => {
        ctx.__closed = true;
        // Only forget this context; a relaunch may already own the slot.
        if (_contexts.get(account)?.ctx === ctx) _contexts.delete(account);
      });
      if (_contexts.get(account) === slot) _contexts.set(account, { ctx });
      return ctx;
    } catch (err) {
      // A transient launch failure (profile lock contention, brief OOM, ...)
      // must not permanently poison this account: clear the slot so the
      // next call retries, but only if it is still ours.
      if (_contexts.get(account) === slot) _contexts.delete(account);
      throw err;
    }
  })();

  _contexts.set(account, slot);
  return slot.pending;
}

export async function getPage(opts) {
  const ctx = await getContext(opts);
  const pages = ctx.pages();
  return pages.length ? pages[0] : ctx.newPage();
}

/**
 * Close one account's browser; the next call relaunches it headless.
 * While it closes, the slot holds the closing promise so no other caller
 * launches a second Chrome against the same (still locked) profile.
 */
export async function closeAccount(account = 'default') {
  const entry = _contexts.get(account);
  if (!entry) return;
  if (entry.closing) return entry.closing;
  const slot = {};
  slot.closing = (async () => {
    const ctx = entry.ctx || (await entry.pending?.catch(() => null));
    if (ctx && !ctx.__closed) await ctx.close().catch(() => {});
  })();
  _contexts.set(account, slot);
  try {
    await slot.closing;
  } finally {
    if (_contexts.get(account) === slot) _contexts.delete(account);
  }
}

export async function closeBrowser() {
  await Promise.all([..._contexts.keys()].map((account) => closeAccount(account)));
}

const SIGN_IN_URL = /accounts\.google\.com|ServiceLogin|signin/i;
const NOTEBOOKLM_URL = /^https:\/\/notebooklm\.google\.com\//i;

/** True when the page is on a Google sign-in screen. */
export function onSignInPage(page) {
  return SIGN_IN_URL.test(page.url());
}

/**
 * True when the persistent profile still holds a valid Google session.
 *
 * With `passive: true` the page is never reloaded while it is already on a
 * Google sign-in screen or on NotebookLM itself: reloading under someone who
 * is halfway through typing a password throws their sign-in away.
 */
export async function isAuthenticated(page, { passive = false } = {}) {
  if (passive) {
    if (onSignInPage(page)) return false;
    if (NOTEBOOKLM_URL.test(page.url())) return true;
  }
  await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return !onSignInPage(page);
}
