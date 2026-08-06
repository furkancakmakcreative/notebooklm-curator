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

/** Best-effort check so a missing Chrome install fails with a clear message. */
function assertChromeInstalled() {
  const candidates = CHROME_PATHS[process.platform];
  if (!candidates) return; // unlisted platform (e.g. Linux) — let Playwright's own error surface
  if (candidates.some((p) => p && fs.existsSync(p))) return;
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
  const existing = _contexts.get(account);
  if (existing?.pending) return existing.pending;
  if (existing?.ctx && !existing.ctx.__closed) return existing.ctx;

  // Two overlapping tool calls at cold start must not both launch a Chrome
  // process against the same profile dir — stash the in-flight promise so a
  // concurrent caller awaits the same launch instead of racing it.
  const pending = (async () => {
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
    ctx.on('close', () => {
      ctx.__closed = true;
      _contexts.delete(account);
    });
    _contexts.set(account, { ctx });
    return ctx;
  })();

  _contexts.set(account, { pending });
  return pending;
}

export async function getPage(opts) {
  const ctx = await getContext(opts);
  const pages = ctx.pages();
  return pages.length ? pages[0] : ctx.newPage();
}

export async function closeBrowser() {
  for (const { ctx } of _contexts.values()) {
    if (ctx && !ctx.__closed) await ctx.close().catch(() => {});
  }
  _contexts.clear();
}

/** True when the persistent profile still holds a valid Google session. */
export async function isAuthenticated(page) {
  await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const url = page.url();
  return !/accounts\.google\.com|ServiceLogin|signin/i.test(url);
}
