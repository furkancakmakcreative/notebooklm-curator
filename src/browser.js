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

let _ctx = null;
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

export function profileDir(account = 'default') {
  const base =
    process.env.NLM_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'notebooklm-curator')
      : path.join(os.homedir(), '.local', 'share', 'notebooklm-curator'));
  const dir = path.join(base, 'accounts', account, 'chrome_profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {object} opts
 * @param {boolean} opts.headless  false shows the window (needed for login)
 * @param {string}  opts.account   profile slug, for multiple Google accounts
 */
export async function getContext({ headless = true, account = 'default' } = {}) {
  if (_ctx && !_ctx.__closed) return _ctx;

  const chromium = await loadChromium();
  _ctx = await chromium.launchPersistentContext(profileDir(account), {
    headless,
    channel: process.env.NLM_BROWSER_CHANNEL || 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  _ctx.__closed = false;
  _ctx.on('close', () => {
    _ctx.__closed = true;
    _ctx = null;
  });
  return _ctx;
}

export async function getPage(opts) {
  const ctx = await getContext(opts);
  const pages = ctx.pages();
  return pages.length ? pages[0] : ctx.newPage();
}

export async function closeBrowser() {
  if (_ctx && !_ctx.__closed) await _ctx.close().catch(() => {});
  _ctx = null;
}

/** True when the persistent profile still holds a valid Google session. */
export async function isAuthenticated(page) {
  await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const url = page.url();
  return !/accounts\.google\.com|ServiceLogin|signin/i.test(url);
}
