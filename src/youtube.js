/**
 * YouTube Data API v3 — publish dates.
 *
 * QUOTA MATTERS. Default daily quota is 10,000 units:
 *   videos.list  = 1 general quota unit per call (up to 50 ids)
 *   search.list  = counted as a search call; kept separate from list units
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

function apiOptions(optionsOrKey = {}) {
  if (typeof optionsOrKey === 'string') return { key: optionsOrKey };
  return optionsOrKey || {};
}

function requestFor(options = {}) {
  return options.request || call;
}

function invalidSource(message) {
  throw new Error(`Invalid YouTube source: ${message}`);
}

function parseHandle(value) {
  const handle = value.startsWith('@') ? value.slice(1) : value;
  if (!/^[A-Za-z0-9._-]+$/.test(handle)) {
    invalidSource('handles must look like @handle');
  }
  return `@${handle}`;
}

function isYouTubeHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be'
  );
}

/** Parse one of the deliberately narrow first-release YouTube source forms. */
export function parseYouTubeSource(input) {
  if (typeof input !== 'string' || !input.trim()) {
    invalidSource('expected a channel ID, @handle, playlist ID, or YouTube URL');
  }

  const value = input.trim();
  if (value.startsWith('@')) {
    return { kind: 'youtube-channel', id: parseHandle(value), handle: parseHandle(value) };
  }
  if (/^UC[A-Za-z0-9_-]+$/.test(value)) {
    return { kind: 'youtube-channel', id: value, channelId: value };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
      return { kind: 'youtube-playlist', id: value, playlistId: value };
    }
    invalidSource('expected a raw ID or a valid YouTube URL');
  }

  if (!/^https?:$/.test(url.protocol) || !isYouTubeHost(url.hostname)) {
    invalidSource('URL must be on youtube.com or youtu.be');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'c') {
    invalidSource('ambiguous legacy /c/ channel URL; use the channel ID or @handle URL');
  }

  const list = url.searchParams.get('list');
  if (list) {
    if (!/^[A-Za-z0-9_-]+$/.test(list)) invalidSource('playlist ID is malformed');
    return { kind: 'youtube-playlist', id: list, playlistId: list };
  }

  if (segments[0] === 'channel') {
    const channelId = segments[1];
    if (!channelId || !/^UC[A-Za-z0-9_-]+$/.test(channelId)) {
      invalidSource('/channel/ URLs must contain a valid UC channel ID');
    }
    return { kind: 'youtube-channel', id: channelId, channelId };
  }
  if (segments[0]?.startsWith('@')) {
    const handle = parseHandle(segments[0]);
    return { kind: 'youtube-channel', id: handle, handle };
  }

  invalidSource('URL must be a /channel/ URL, an /@handle URL, or contain list=');
}

function sourceTitle(item) {
  return item?.snippet?.title || null;
}

/** Resolve a channel to its uploads playlist, or fetch playlist metadata. */
export async function resolveYouTubeSource(input, options = {}) {
  const parsed = parseYouTubeSource(input);
  const { key } = apiOptions(options);
  const request = requestFor(apiOptions(options));

  if (parsed.kind === 'youtube-channel') {
    const params = {
      part: 'snippet,contentDetails',
      ...(parsed.channelId ? { id: parsed.channelId } : { forHandle: parsed.handle.slice(1) }),
    };
    const json = await request('channels', params, key);
    const item = json?.items?.[0];
    if (!item?.id) throw new Error('YouTube channel was not found');

    return {
      kind: 'youtube-channel',
      canonicalId: item.id,
      channelId: item.id,
      title: sourceTitle(item),
      channelTitle: sourceTitle(item),
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
    };
  }

  const json = await request(
    'playlists',
    { part: 'snippet,contentDetails', id: parsed.playlistId },
    key,
  );
  const item = json?.items?.[0];
  if (!item?.id) throw new Error('YouTube playlist was not found');

  return {
    kind: 'youtube-playlist',
    canonicalId: item.id,
    playlistId: item.id,
    title: sourceTitle(item),
    channelId: item.snippet?.channelId || null,
    channelTitle: item.snippet?.channelTitle || null,
  };
}

function normalizePlaylistItem(item) {
  const snippet = item?.snippet || {};
  const contentDetails = item?.contentDetails || {};
  const videoId = contentDetails.videoId || snippet.resourceId?.videoId;
  if (!videoId) return null;
  if (/^\[?(?:private|deleted) video\]?$/i.test(String(snippet.title || '').trim())) {
    return null;
  }

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: snippet.title || null,
    channelId: snippet.videoOwnerChannelId || snippet.channelId || null,
    channelTitle: snippet.videoOwnerChannelTitle || snippet.channelTitle || null,
    publishedAt: contentDetails.videoPublishedAt || snippet.publishedAt || null,
  };
}

/**
 * Fetch playlist items newest-first. The cursor item is a boundary and is not
 * returned. Playlist-items.list costs one general quota unit per request.
 */
export async function fetchPlaylistItems(playlistId, options = {}) {
  if (typeof playlistId !== 'string' || !playlistId.trim()) {
    throw new Error('A playlist ID is required');
  }

  const opts = apiOptions(options);
  const request = requestFor(opts);
  const maxPages = opts.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  const items = [];
  const seen = new Set();
  let pageToken;
  let newestVideoId = null;
  let cursorFound = false;
  let pages = 0;
  let nextPageToken = null;

  while (pages < maxPages) {
    const params = {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    };
    const json = await request('playlistItems', params, opts.key);
    pages++;

    let stop = false;
    for (const rawItem of json?.items || []) {
      // Cursor identity must survive YouTube replacing a video's metadata
      // with a Private/Deleted placeholder. Filtering decides whether an
      // item becomes a candidate; it must not hide the pagination boundary.
      const rawVideoId =
        rawItem?.contentDetails?.videoId || rawItem?.snippet?.resourceId?.videoId || null;
      if (!newestVideoId && rawVideoId) newestVideoId = rawVideoId;
      if (rawVideoId && rawVideoId === opts.untilVideoId) {
        cursorFound = true;
        stop = true;
        break;
      }
      const item = normalizePlaylistItem(rawItem);
      if (!item) continue;
      if (!seen.has(item.videoId)) {
        seen.add(item.videoId);
        items.push(item);
      }
    }

    nextPageToken = json?.nextPageToken || null;
    if (stop || !nextPageToken) break;
    pageToken = nextPageToken;
  }

  items.sort((a, b) => {
    const aTime = Date.parse(a.publishedAt || '');
    const bTime = Date.parse(b.publishedAt || '');
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    if (Number.isFinite(bTime) !== Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : -1;
    return 0;
  });

  return {
    playlistId,
    newestVideoId,
    cursorFound,
    items,
    pages,
    quotaUnits: pages,
    truncated: !cursorFound && Boolean(nextPageToken) && pages >= maxPages,
  };
}

/** Discover a watch using its resolved uploads playlist or playlist ID. */
export async function discoverWatch(watch, options = {}) {
  if (!watch || typeof watch !== 'object') throw new Error('A watch record is required');
  const playlistId = watch.uploadsPlaylistId || watch.canonicalId;
  if (!playlistId) throw new Error('Watch has no playlist ID');
  const fetchOptions = {
    ...options,
    ...(options.untilVideoId === undefined && watch.cursorVideoId
      ? { untilVideoId: watch.cursorVideoId }
      : {}),
  };
  return {
    ...await fetchPlaylistItems(playlistId, fetchOptions),
    playlistId,
  };
}

/**
 * Cheap path: resolve up to 50 known video ids per call. 1 quota unit.
 * Ids missing from the response no longer exist (deleted or private).
 */
export async function datesByIds(videoIds, optionsOrKey) {
  const options = apiOptions(optionsOrKey);
  const request = requestFor(options);
  const out = new Map();
  const missing = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const json = await request('videos', { part: 'snippet', id: batch.join(',') }, options.key);
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
 * Expensive path: resolve one title to a video. Search calls are tracked
 * separately by enrich; this function itself does not assign list units.
 * Returns null when nothing matches confidently.
 */
export async function resolveTitle(title, optionsOrKey) {
  const options = apiOptions(optionsOrKey);
  const request = requestFor(options);
  const json = await request(
    'search',
    { part: 'snippet', type: 'video', maxResults: '3', q: title },
    options.key,
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
export async function enrich(entries, { key, budget = 60, request } = {}) {
  const known = entries.filter((e) => e.videoId);
  const unknown = entries.filter((e) => !e.videoId);
  const results = [];

  if (known.length) {
    const { found, missing } = await datesByIds(known.map((e) => e.videoId), { key, request });
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
      const hit = await resolveTitle(e.title, { key, request });
      results.push(
        hit ? { ...e, ...hit, resolved: 'search' } : { ...e, resolved: 'nomatch' },
      );
    } catch (err) {
      results.push({ ...e, resolved: 'error', note: String(err.message) });
      if (/quota/i.test(err.message)) break; // stop burning a dead quota
    }
  }

  const listRequests = Math.ceil(known.length / 50);
  const totalRequestUnitsApprox = listRequests + spent;
  return {
    results,
    searchesSpent: spent,
    searchCallsSpent: spent,
    quotaUnitsApprox: totalRequestUnitsApprox,
    quota: {
      searchCalls: spent,
      searchRequestUnits: spent,
      listRequests,
      listUnits: listRequests,
      totalRequestUnitsApprox,
    },
  };
}
