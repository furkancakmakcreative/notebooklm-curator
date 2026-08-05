/**
 * YouTube Data API v3 — publish dates.
 *
 * QUOTA MATTERS. Default daily quota is 10,000 units:
 *   videos.list  =   1 unit  per call (up to 50 ids)  -> 83 sources = 2 units
 *   search.list  = 100 units per call (1 title)       -> 83 titles  = 8,300 units
 *
 * NotebookLM never exposes source URLs, so the first pass has to search
 * by title. That is expensive but ONE TIME: search returns the videoId,
 * you persist it, and every later refresh uses videos.list for ~nothing.
 *
 * Always cache ids. Never re-search a title you already resolved.
 */

const BASE = 'https://www.googleapis.com/youtube/v3';

function requireKey(key) {
  const k = key || process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error('YOUTUBE_API_KEY is not set (add it to your .env file)');
  return k;
}

/** Strip the API key out of anything that might end up in an error string. */
function redactKey(s) {
  return String(s).replace(/([?&]key=)[^&\s]+/gi, '$1REDACTED');
}

async function call(path, params, key) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', requireKey(key));

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // Some runtimes embed the full request URL (key included) in fetch errors.
    throw new Error(`YouTube API request failed: ${redactKey(err?.message || err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status}: ${redactKey(body.slice(0, 300))}`);
  }
  return res.json();
}

/**
 * Cheap path: resolve up to 50 known video ids per call. 1 quota unit.
 * Ids missing from the response no longer exist (deleted or private).
 */
export async function datesByIds(videoIds, key) {
  const out = new Map();
  const missing = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const json = await call('videos', { part: 'snippet', id: batch.join(',') }, key);
    const got = new Set();
    for (const item of json.items || []) {
      got.add(item.id);
      out.set(item.id, {
        videoId: item.id,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
      });
    }
    for (const id of batch) if (!got.has(id)) missing.push(id);
  }
  return { found: out, missing };
}

/**
 * Expensive path: resolve one title to a video. 100 quota units per call.
 * Returns null when nothing matches confidently.
 */
export async function resolveTitle(title, key) {
  const json = await call(
    'search',
    { part: 'snippet', type: 'video', maxResults: '3', q: title },
    key,
  );
  const items = json.items || [];
  if (!items.length) return null;

  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const target = norm(title);
  const scored = items
    .map((it) => {
      const cand = norm(it.snippet.title);
      const a = new Set(target.split(' '));
      const b = new Set(cand.split(' '));
      let hit = 0;
      for (const w of a) if (b.has(w)) hit++;
      return { it, score: hit / Math.max(a.size, 1) };
    })
    .sort((x, y) => y.score - x.score);

  const best = scored[0];
  // Below ~55% token overlap it is probably a different video; say so
  // rather than writing a wrong date into the manifest.
  if (best.score < 0.55) return null;

  return {
    videoId: best.it.id.videoId,
    title: best.it.snippet.title,
    channel: best.it.snippet.channelTitle,
    publishedAt: best.it.snippet.publishedAt,
    matchScore: Number(best.score.toFixed(2)),
  };
}

/**
 * Resolve a list of {title, videoId?} entries, preferring cached ids.
 * `budget` caps how many expensive title searches we are willing to spend.
 */
export async function enrich(entries, { key, budget = 60 } = {}) {
  const known = entries.filter((e) => e.videoId);
  const unknown = entries.filter((e) => !e.videoId);
  const results = [];

  if (known.length) {
    const { found, missing } = await datesByIds(known.map((e) => e.videoId), key);
    for (const e of known) {
      const hit = found.get(e.videoId);
      results.push(
        hit
          ? { ...e, ...hit, resolved: 'id' }
          : { ...e, resolved: 'gone', note: 'video removed or private' },
      );
    }
    void missing;
  }

  let spent = 0;
  for (const e of unknown) {
    if (spent >= budget) {
      results.push({ ...e, resolved: 'skipped', note: 'search budget exhausted' });
      continue;
    }
    spent++;
    try {
      const hit = await resolveTitle(e.title, key);
      results.push(
        hit ? { ...e, ...hit, resolved: 'search' } : { ...e, resolved: 'nomatch' },
      );
    } catch (err) {
      results.push({ ...e, resolved: 'error', note: String(err.message) });
      if (/quota/i.test(err.message)) break; // stop burning a dead quota
    }
  }

  return { results, searchesSpent: spent, quotaUnitsApprox: spent * 100 + Math.ceil(known.length / 50) };
}
