/**
 * DOM layer for Gemini Notebook (formerly NotebookLM).
 *
 * Every selector here was verified live against notebooklm.google.com
 * on 2026-07-29 (chat completion signal added 2026-08-05). When Google
 * ships a UI change this is the only file that should need edits — keep
 * DOM knowledge out of the tool layer.
 */

// Serializes calls that share a `page` (e.g. two overlapping nlm_ask calls)
// so they can't interleave on the same textarea/DOM state, and so the
// MIN_ASK_INTERVAL_MS throttle below can't be read-then-written by two
// callers at once.
const pageLocks = new WeakMap();
function withPageLock(page, fn) {
  const prev = pageLocks.get(page) || Promise.resolve();
  const run = prev.then(fn, fn);
  pageLocks.set(page, run.catch(() => {}));
  return run;
}

export const SEL = {
  // Notebook grid (home page)
  notebookCard: 'a[href*="/notebook/"]',

  // Source list (inside a notebook)
  sourceItem: '.single-source-container',
  sourceIcon: '.source-item-source-icon',
  sourceMoreButton: '.source-item-more-button',

  // Overflow menu entries
  menuItem: '[role="menuitem"], .mat-mdc-menu-item',
};

/** Icon ligature -> our source type. */
const ICON_TYPE = {
  video_youtube: 'youtube',
  link: 'web',
  description: 'doc',
  picture_as_pdf: 'pdf',
};

/** Strings the UI renders as icon ligatures; never part of a title. */
const LIGATURES = [
  ...Object.keys(ICON_TYPE),
  'label_auto',
  'more_vert',
  'check',
];

export function notebookIdFromUrl(url) {
  const m = String(url).match(/\/notebook\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

export async function gotoHome(page) {
  await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
}

/**
 * A brand-new notebook has zero sources, so SEL.sourceItem never appears —
 * wait for it OR the "add source" button (always present once the notebook
 * shell has loaded) so this doesn't time out on empty notebooks.
 */
export async function gotoNotebook(page, notebookId) {
  await page.goto(`https://notebooklm.google.com/notebook/${notebookId}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await page.waitForTimeout(1500); // Angular hydration of the source panel
  await Promise.race([
    page.waitForSelector(SEL.sourceItem, { timeout: 30000 }),
    page
      .locator('[aria-label="Kaynak ekle"], [aria-label="Add source"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 }),
  ]);
}

/**
 * The "NotebookLM is now Gemini Notebook" interstitial blocks all clicks.
 * It is informational only — dismissing it accepts no terms.
 */
export async function dismissWelcome(page) {
  const btn = page.getByRole('button', { name: /Başlayalım|Get started/i });
  try {
    await btn.first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return;
  }
  await btn.first().click({ timeout: 3000 }).catch(() => {});
  await page
    .locator('.cdk-overlay-backdrop')
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {});
}

/**
 * Every notebook on the home page: {id, title, sourceCount}.
 *
 * The card's <a> is an empty click-target overlay (material ripple button) —
 * innerText on it is always "". The real title/subtitle live in sibling
 * nodes inside the enclosing <mat-card>, addressed by
 * #project-<id>-title / #project-<id>-subtitle. Verified 2026-08-04.
 */
export async function listNotebooks(page) {
  await gotoHome(page);
  await page.waitForSelector(SEL.notebookCard, { timeout: 30000 });
  return page.$$eval(SEL.notebookCard, (cards) =>
    cards
      .map((a) => {
        const href = a.getAttribute('href') || '';
        const id = (href.match(/\/notebook\/([0-9a-f-]{36})/i) || [])[1];
        if (!id) return null;
        const card = a.closest('mat-card') || a.parentElement || a;
        const titleEl = card.querySelector(`#project-${id}-title`);
        const subtitleEl = card.querySelector(`#project-${id}-subtitle`);
        const title = (titleEl?.textContent || '').trim();
        const subtitle = (subtitleEl?.textContent || '').trim();
        const count = parseInt(
          (subtitle.match(/(\d+)\s*(kaynak|source)/i) || [])[1] || '0',
          10,
        );
        return { id, title: title || '(untitled)', sourceCount: count };
      })
      .filter(Boolean),
  );
}

/**
 * Sources in the open notebook: {index, type, title}.
 *
 * NOTE: NotebookLM does NOT expose source URLs anywhere in the DOM —
 * no href, no data attribute, no image, and clicking a row does not
 * reveal one. Verified 2026-07-29. Titles are the only stable
 * identifier, which is why removeSource() matches on title.
 */
export async function listSources(page) {
  return page.$$eval(
    SEL.sourceItem,
    (nodes, cfg) =>
      nodes.map((el, i) => {
        const icon = el.querySelector(cfg.iconSel);
        const lig = icon ? (icon.textContent || '').trim() : '';
        const lines = (el.innerText || '')
          .trim()
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !cfg.ligatures.includes(s));
        return {
          index: i,
          type: cfg.iconType[lig] || 'web',
          title: lines.join(' ').replace(/\s+/g, ' ').trim(),
        };
      }),
    { iconSel: SEL.sourceIcon, iconType: ICON_TYPE, ligatures: LIGATURES },
  );
}

/**
 * @param {number|undefined} occurrence  Which match to target when the
 *   title is duplicated (0-based, in list order). Undefined means the
 *   caller did not disambiguate.
 */
async function findSourceIndex(page, title, occurrence) {
  const sources = await listSources(page);
  const matches = sources.filter((s) => s.title === title);
  if (matches.length > 1 && occurrence === undefined) {
    // Ambiguous — caller must pick which one via `occurrence`.
    return { ambiguous: true, matchCount: matches.length };
  }
  const hit = matches[occurrence ?? 0];
  return hit ? { index: hit.index, matchCount: matches.length } : { index: null };
}

/**
 * Delete a source by exact title. Destructive and irreversible —
 * the caller must have obtained explicit user confirmation first.
 * If the title is duplicated, pass `occurrence` (0-based) to disambiguate;
 * otherwise this refuses to guess and returns ambiguous:true.
 */
export async function removeSource(page, title, occurrence) {
  const found = await findSourceIndex(page, title, occurrence);
  if (found.ambiguous) {
    return {
      removed: false,
      reason: `title matches ${found.matchCount} sources; pass occurrence to disambiguate`,
      matchCount: found.matchCount,
    };
  }
  const idx = found.index;
  if (idx === null) return { removed: false, reason: 'source not found' };

  const beforeSources = await listSources(page);
  const before = beforeSources.length;
  // Re-check the target row's title right before acting on it — the list
  // can reorder between the initial scan and this point (async metadata,
  // lazy load), and index-based targeting alone could hit the wrong row.
  if (beforeSources[idx]?.title !== title) {
    return { removed: false, reason: 'source list changed before the delete could run; retry' };
  }
  const row = page.locator(SEL.sourceItem).nth(idx);

  await row.hover();
  await row.locator(SEL.sourceMoreButton).first().click();
  await page.waitForTimeout(600);

  const remove = page
    .locator(SEL.menuItem)
    .filter({ hasText: /Kaynağı kaldır|Remove source|Delete source/i });
  if (!(await remove.count())) {
    await page.keyboard.press('Escape');
    return { removed: false, reason: 'remove menu item not found' };
  }
  await remove.first().click();
  await page.waitForTimeout(800);

  // A confirmation dialog may or may not appear depending on rollout.
  const confirm = page.getByRole('button', {
    name: /^(Sil|Kaldır|Delete|Remove|Onayla|Confirm)$/i,
  });
  if (await confirm.count().catch(() => 0)) {
    await confirm.first().click().catch(() => {});
    await page.waitForTimeout(800);
  }

  const afterSources = await listSources(page);
  const after = afterSources.length;
  const remainingWithTitle = afterSources.filter((s) => s.title === title).length;
  const expectedRemaining = (found.matchCount ?? 1) - 1;
  return after < before && remainingWithTitle === expectedRemaining
    ? { removed: true, before, after }
    : {
        removed: false,
        reason:
          after < before
            ? 'source count dropped but the remaining title count looks off'
            : 'source count unchanged; the delete may not have completed',
      };
}

/**
 * Create a new (blank) notebook and optionally rename it.
 * The home page's "create-new-button" navigates straight to a fresh
 * notebook URL — no dialog. New notebooks default to an untitled name.
 */
export async function createNotebook(page, title) {
  await gotoHome(page);
  await page.locator('.create-new-button').click();
  await page.waitForURL(/\/notebook\/[0-9a-f-]{36}/, { timeout: 20000 });
  const id = notebookIdFromUrl(page.url());
  if (title) {
    await renameNotebook(page, title);
  }
  return { id, url: page.url() };
}

/** Rename the currently open notebook via its inline title input. */
export async function renameNotebook(page, title) {
  const input = page.locator('input.title-input');
  await input.click();
  await input.fill(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  return { title };
}

/** Add a URL as a new source. */
export async function addSource(page, url) {
  await page
    .locator('[aria-label="Kaynak ekle"], [aria-label="Add source"]')
    .first()
    .click();
  await page.waitForTimeout(1200);

  const field = page.locator('input[type="url"], input[type="text"], textarea').last();
  await field.fill(url);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  return { added: true, url };
}

/**
 * Ask the notebook a question; returns {text, incomplete}.
 *
 * The chat panel renders OUTSIDE <main> — polling main's innerText for
 * "stability" (a natural first instinct) never changes and falsely
 * reports done almost instantly, returning unrelated hidden UI text.
 * The reliable signal is the ".thinking-message" indicator (it carries
 * an "is-changing" class while streaming) detaching from the DOM. The
 * query textarea's disabled state re-enables slightly after that, so
 * both are awaited before reading the last answer. Verified 2026-08-05.
 *
 * If NotebookLM's DOM ever changes and these selectors stop matching,
 * the waits below time out silently (by design, so one broken selector
 * doesn't hang forever) — `incomplete: true` on the return value is the
 * caller-visible signal that the text may be stale or truncated rather
 * than a confirmed final answer.
 */
// Firing questions back-to-back is the one pattern real NotebookLM usage
// never produces, and it's a plausible trigger for "Şu anda yanıt vermekte
// zorlanıyorum" (the tool briefly refusing to answer). A minimum gap between
// question submissions is cheap insurance against that, tunable per install.
const MIN_ASK_INTERVAL_MS = Number(process.env.NLM_MIN_ASK_INTERVAL_MS) || 4000;
let lastAskSubmittedAt = 0;

export async function ask(page, question, opts = {}) {
  return withPageLock(page, () => askOnce(page, question, opts));
}

async function askOnce(page, question, opts) {
  const timeoutMs = opts.timeoutMs || 180000;
  const sinceLastAsk = Date.now() - lastAskSubmittedAt;
  if (sinceLastAsk < MIN_ASK_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_ASK_INTERVAL_MS - sinceLastAsk));
  }
  lastAskSubmittedAt = Date.now();

  const box = page.locator('textarea, [contenteditable="true"]').last();
  await box.click();
  await box.fill(question);
  await page.keyboard.press('Enter');

  await page.waitForTimeout(1500);
  const thinkingDetached = await page
    .locator('.thinking-message')
    .first()
    .waitFor({ state: 'detached', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  // The query box re-enables slightly after the thinking indicator detaches.
  await box.locator('xpath=.').waitFor({ state: 'attached' }).catch(() => {});
  const boxReenabled = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('textarea[aria-label="Sorgu kutusu"], textarea[aria-label="Query box"], [contenteditable="true"]');
        return el && !el.disabled;
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);

  const text = await page.evaluate(() => {
    const pairs = document.querySelectorAll('.chat-message-pair');
    const last = pairs[pairs.length - 1];
    if (!last) return '';
    const el = last.querySelector('.to-user-message-inner-content .message-text-content')
      || last.querySelector('.to-user-message-inner-content');
    return (el?.innerText || '').trim();
  });

  return { text, incomplete: !thinkingDetached || !boxReenabled || !text };
}
