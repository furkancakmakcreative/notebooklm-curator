/**
 * Freshness policy — the opinionated part of the system.
 *
 * Deliberately library-agnostic: shelf life is a function of CATEGORY,
 * not of a single global day count. A 400-day-old typography video is
 * fine; a 40-day-old model announcement is landfill.
 */

export const DEFAULT_POLICY = {
  categories: {
    news: { days: 30, label: 'announcement / release note / weekly roundup' },
    tactics: { days: 45, label: 'rate limits, model ranking/picking — advice tied to a moving target' },
    tool: { days: 60, label: 'tool usage, workflow tied to a release (general / third-party)' },
    official: { days: 150, label: 'Anthropic/Claude official product-feature video — valid until explicit deprecation' },
    tutorial: { days: 120, label: 'course, walkthrough, technical deep-dive' },
    principle: { days: 1095, label: 'theory, strategy, timeless craft' },
  },
  fallback: 'tool',
  /** Warn once the source has burned this fraction of its shelf life. */
  warnRatio: 0.75,
  /** Channel names treated as official Anthropic/Claude content for the `official` category. */
  officialChannels: ['claude', 'anthropic'],
};

/**
 * Heuristics for first-pass categorisation. Deliberately conservative:
 * anything unmatched lands in `fallback` and a human confirms.
 * Order matters — first match wins. `news` and `tactics` are checked before
 * the official-channel bonus: a weekly roundup or a rate-limit workaround
 * ages fast even when Anthropic itself posts it.
 */
const RULES = [
  {
    cat: 'news',
    re: /(just dropped|leak|announc|is here|update you|new feature|this week|april fools|changed forever|breaking)/i,
  },
  {
    cat: 'tactics',
    re: /(session limit|rate limit|quota|best model|which model|stop using|compare|vs\.?\s|ranking)/i,
  },
  {
    cat: 'tutorial',
    re: /(course|tutorial|full guide|guide|step by step|\d+\s*hour|masterclass|from zero|learn)/i,
  },
  {
    cat: 'principle',
    re: /(principle|theory|strategy|mindset|why |philosophy|thinking|architecture)/i,
  },
  {
    cat: 'tool',
    re: /(how to|setup|tips|tricks|hack|workflow|plugin|skill|feature|using)/i,
  },
];

/**
 * @param {string} title
 * @param {object} policy
 * @param {string|null} [channel]  Source channel, if known — an official
 *   Anthropic/Claude channel bumps unmatched titles to the long-lived
 *   `official` category instead of the generic `tool` fallback.
 */
export function guessCategory(title, policy = DEFAULT_POLICY, channel) {
  const t = String(title || '');
  for (const r of RULES) if (r.re.test(t)) return r.cat;

  const ch = String(channel || '').trim().toLowerCase();
  const official = (policy.officialChannels || []).some((name) => ch === name);
  if (official && policy.categories.official) return 'official';

  return policy.fallback;
}

export function shelfLifeDays(category, policy = DEFAULT_POLICY, override) {
  if (Number.isFinite(override) && override > 0) return override;
  const c = policy.categories[category];
  return c ? c.days : policy.categories[policy.fallback].days;
}

export function ageInDays(publishedAt, now = new Date()) {
  if (!publishedAt) return null;
  const then = new Date(publishedAt);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now - then) / 86400000);
}

/**
 * Classify one source.
 * @returns {{status:'fresh'|'aging'|'stale'|'unknown'|'pinned', age:number|null, shelfLife:number, overBy:number|null}}
 */
export function classify(source, policy = DEFAULT_POLICY, now = new Date()) {
  const shelfLife = shelfLifeDays(source.category, policy, source.shelfLifeOverride);

  if (source.pinned) {
    return { status: 'pinned', age: ageInDays(source.publishedAt, now), shelfLife, overBy: null };
  }

  const age = ageInDays(source.publishedAt, now);
  if (age === null) {
    return { status: 'unknown', age: null, shelfLife, overBy: null };
  }

  const overBy = age - shelfLife;
  if (overBy > 0) return { status: 'stale', age, shelfLife, overBy };
  if (age >= shelfLife * policy.warnRatio) return { status: 'aging', age, shelfLife, overBy };
  return { status: 'fresh', age, shelfLife, overBy };
}

/** Classify a list and bucket it for reporting. */
export function audit(sources, policy = DEFAULT_POLICY, now = new Date()) {
  const rows = sources.map((s) => ({ ...s, ...classify(s, policy, now) }));
  const bucket = (st) => rows.filter((r) => r.status === st);
  return {
    counts: {
      total: rows.length,
      fresh: bucket('fresh').length,
      aging: bucket('aging').length,
      stale: bucket('stale').length,
      unknown: bucket('unknown').length,
      pinned: bucket('pinned').length,
    },
    stale: bucket('stale').sort((a, b) => b.overBy - a.overBy),
    aging: bucket('aging').sort((a, b) => b.age - a.age),
    unknown: bucket('unknown'),
    all: rows,
  };
}

/** Exact-title duplicates — free wins, no publish date needed. */
export function findDuplicates(sources) {
  const seen = new Map();
  for (const s of sources) {
    const k = s.title.trim().toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([title, count]) => ({ title, count }));
}
