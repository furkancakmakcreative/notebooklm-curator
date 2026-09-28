import assert from 'node:assert/strict';
import test from 'node:test';

import {
  channelIdFromPage,
  discoverWatch,
  parseFeed,
  resolveYouTubeSource,
} from '../src/youtube.js';

const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

function entry(id, title, published) {
  return `<entry>
  <id>yt:video:${id}</id>
  <yt:videoId>${id}</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>${title}</title>
  <author><name>Dev Channel</name></author>
  <published>${published}</published>
 </entry>`;
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>${CHANNEL}</yt:channelId>
 <title>Dev Channel</title>
 <author><name>Dev Channel</name></author>
 ${entry('newest00001', 'Q&amp;A: what&#39;s new', '2026-09-20T10:00:00+00:00')}
 ${entry('middle00002', '<![CDATA[Middle]]>', '2026-09-15T10:00:00+00:00')}
 ${entry('cursor00003', 'Already seen', '2026-09-10T10:00:00+00:00')}
 ${entry('older000004', 'Older', '2026-09-01T10:00:00+00:00')}
</feed>`;

function stubFetch(pages) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    for (const [needle, body] of Object.entries(pages)) {
      if (url.includes(needle)) {
        if (body instanceof Error) throw body;
        return body;
      }
    }
    const error = new Error('HTTP 404');
    error.status = 404;
    throw error;
  };
  return { fetchText, calls };
}

test('parses feed entries, decodes entities and CDATA, and reads the feed title', () => {
  const feed = parseFeed(FEED);
  assert.equal(feed.title, 'Dev Channel');
  assert.equal(feed.channelId, CHANNEL);
  assert.deepEqual(
    feed.items.map((item) => [item.videoId, item.title]),
    [
      ['newest00001', "Q&A: what's new"],
      ['middle00002', 'Middle'],
      ['cursor00003', 'Already seen'],
      ['older000004', 'Older'],
    ],
  );
  assert.equal(feed.items[0].url, 'https://www.youtube.com/watch?v=newest00001');
  assert.equal(feed.items[0].channelTitle, 'Dev Channel');
  assert.equal(feed.items[0].publishedAt, '2026-09-20T10:00:00+00:00');
  assert.throws(() => parseFeed('<html>consent</html>'), /not valid XML/);
});

test('finds the channel ID on a channel page', () => {
  assert.equal(
    channelIdFromPage(`<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}">`),
    CHANNEL,
  );
  assert.equal(channelIdFromPage(`{"externalId":"${CHANNEL}"}`), CHANNEL);
  assert.equal(channelIdFromPage('<html></html>'), null);
});

test('without an API key, handles resolve through the channel page and the feed', async () => {
  const { fetchText, calls } = stubFetch({
    '/@devchannel': `{"externalId":"${CHANNEL}"}`,
    [`channel_id=${CHANNEL}`]: FEED,
  });
  const resolved = await resolveYouTubeSource('https://www.youtube.com/@devchannel', {
    fetchText,
    useFeeds: true,
  });
  assert.deepEqual(resolved, {
    kind: 'youtube-channel',
    canonicalId: CHANNEL,
    channelId: CHANNEL,
    title: 'Dev Channel',
    channelTitle: 'Dev Channel',
    uploadsPlaylistId: 'UU_x5XG1OV2P6uZZ5FSM9Ttw',
    via: 'rss',
  });
  assert.equal(calls[0], 'https://www.youtube.com/@devchannel');
});

test('keyless channel IDs skip the page lookup and playlists read the playlist feed', async () => {
  const { fetchText, calls } = stubFetch({
    [`channel_id=${CHANNEL}`]: FEED,
    'playlist_id=PLabc': FEED.replace('<title>Dev Channel</title>', '<title>Talks</title>'),
  });
  const channel = await resolveYouTubeSource(CHANNEL, { fetchText, useFeeds: true });
  assert.equal(channel.canonicalId, CHANNEL);
  const playlist = await resolveYouTubeSource('https://www.youtube.com/playlist?list=PLabc', {
    fetchText,
    useFeeds: true,
  });
  assert.equal(playlist.kind, 'youtube-playlist');
  assert.equal(playlist.canonicalId, 'PLabc');
  assert.equal(playlist.title, 'Talks');
  assert.equal(playlist.channelId, CHANNEL);
  assert.ok(calls.every((url) => url.startsWith('https://www.youtube.com/feeds/videos.xml?')));
});

test('keyless handle lookups explain what to do when the page has no channel ID', async () => {
  const { fetchText } = stubFetch({ '/@devchannel': '<html>consent page</html>' });
  await assert.rejects(
    resolveYouTubeSource('@devchannel', { fetchText, useFeeds: true }),
    /\/channel\/UC\.\.\., or set YOUTUBE_API_KEY/,
  );
  await assert.rejects(
    resolveYouTubeSource(CHANNEL, { fetchText: stubFetch({}).fetchText, useFeeds: true }),
    /YouTube channel was not found/,
  );
});

test('feed discovery stops at the cursor and never reports truncation', async () => {
  const { fetchText } = stubFetch({ [`channel_id=${CHANNEL}`]: FEED });
  const watch = { kind: 'youtube-channel', canonicalId: CHANNEL, cursorVideoId: 'cursor00003' };
  const found = await discoverWatch(watch, { fetchText, useFeeds: true });
  assert.deepEqual(found.items.map((item) => item.videoId), ['newest00001', 'middle00002']);
  assert.equal(found.newestVideoId, 'newest00001');
  assert.equal(found.cursorFound, true);
  assert.equal(found.truncated, false);
  assert.equal(found.quotaUnits, 0);

  // Cursor video deleted: only videos after the last successful check count,
  // never videos from before the watch existed.
  const lost = await discoverWatch(
    {
      ...watch,
      cursorVideoId: 'gone0000000',
      createdAt: '2026-09-05T00:00:00.000Z',
      lastSuccessAt: '2026-09-18T12:00:00.000Z',
    },
    { fetchText, useFeeds: true },
  );
  assert.deepEqual(lost.items.map((item) => item.videoId), ['newest00001']);
  assert.equal(lost.cursorFound, false);
  assert.equal(lost.truncated, false);
  assert.equal(lost.warning, null, 'a short feed cannot hide a gap');

  const neverSynced = await discoverWatch(
    { ...watch, cursorVideoId: 'gone0000000', createdAt: '2026-09-12T00:00:00.000Z', lastSuccessAt: null },
    { fetchText, useFeeds: true },
  );
  assert.deepEqual(neverSynced.items.map((item) => item.videoId), ['newest00001', 'middle00002']);

  const noTimestamps = await discoverWatch({ ...watch, cursorVideoId: 'gone0000000' }, { fetchText, useFeeds: true });
  assert.deepEqual(noTimestamps.items, []);
  assert.match(noTimestamps.warning, /nothing was queued/);

  const baseline = await discoverWatch(watch, { fetchText, useFeeds: true, untilVideoId: null });
  assert.equal(baseline.items.length, 4);
});

test('an API key or an injected API request keeps the Data API path', async () => {
  let apiCalls = 0;
  const request = async () => {
    apiCalls++;
    return { items: [{ id: CHANNEL, snippet: { title: 'Dev' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] };
  };
  const resolved = await resolveYouTubeSource(CHANNEL, { request });
  assert.equal(apiCalls, 1);
  assert.equal(resolved.uploadsPlaylistId, 'UUx');
  assert.equal(resolved.via, undefined);
});

test('a full feed newer than the last check warns that uploads may have been missed', async () => {
  const entries = Array.from({ length: 15 }, (_, i) =>
    entry(`burst${String(i).padStart(6, '0')}`, `Burst ${i}`, new Date(Date.parse('2026-09-20T00:00:00Z') - i * 3600e3).toISOString()),
  ).join('');
  const feed = FEED.replace(/<entry>[\s\S]*<\/entry>/, entries);
  const { fetchText } = stubFetch({ [`channel_id=${CHANNEL}`]: feed });
  const found = await discoverWatch(
    { kind: 'youtube-channel', canonicalId: CHANNEL, cursorVideoId: 'old00000000', createdAt: '2026-09-01T00:00:00Z', lastSuccessAt: '2026-09-10T00:00:00Z' },
    { fetchText, useFeeds: true },
  );
  assert.equal(found.items.length, 15);
  assert.match(found.warning, /more than 15 videos/);
});
