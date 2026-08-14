import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverWatch,
  enrich,
  fetchPlaylistItems,
  parseYouTubeSource,
  resolveYouTubeSource,
} from '../src/youtube.js';

function playlistItem(videoId, publishedAt, extra = {}) {
  return {
    snippet: {
      title: extra.title || `Video ${videoId}`,
      channelId: extra.channelId || 'UCchannel',
      channelTitle: extra.channelTitle || 'Channel',
      publishedAt,
      resourceId: { videoId },
      ...extra.snippet,
    },
    contentDetails: {
      videoId,
      videoPublishedAt: publishedAt,
      ...extra.contentDetails,
    },
  };
}

test('parses supported channel and playlist inputs', () => {
  assert.deepEqual(parseYouTubeSource('UC123'), {
    kind: 'youtube-channel',
    id: 'UC123',
    channelId: 'UC123',
  });
  assert.deepEqual(parseYouTubeSource('@creator'), {
    kind: 'youtube-channel',
    id: '@creator',
    handle: '@creator',
  });
  assert.equal(
    parseYouTubeSource('https://www.youtube.com/channel/UCabc').channelId,
    'UCabc',
  );
  assert.equal(
    parseYouTubeSource('https://youtube.com/@creator/videos').handle,
    '@creator',
  );
  assert.deepEqual(parseYouTubeSource('PLrawPlaylist'), {
    kind: 'youtube-playlist',
    id: 'PLrawPlaylist',
    playlistId: 'PLrawPlaylist',
  });
  assert.equal(
    parseYouTubeSource('https://www.youtube.com/playlist?list=PLfromUrl').playlistId,
    'PLfromUrl',
  );
});

test('rejects ambiguous custom channels and unrelated URLs clearly', () => {
  assert.throws(
    () => parseYouTubeSource('https://www.youtube.com/c/creator'),
    /ambiguous.*\/c\//i,
  );
  assert.throws(
    () => parseYouTubeSource('https://example.com/channel/UCabc'),
    /youtube\.com or youtu\.be/i,
  );
  assert.throws(
    () => parseYouTubeSource('https://www.youtube.com/watch?v=abc'),
    /must be a \/channel\/ URL.*contain list=/i,
  );
});

test('resolves channels by id or handle and playlists by metadata', async () => {
  const calls = [];
  const request = async (path, params, key) => {
    calls.push({ path, params, key });
    if (path === 'channels') {
      return {
        items: [{
          id: 'UCresolved',
          snippet: { title: 'Resolved Channel' },
          contentDetails: { relatedPlaylists: { uploads: 'UUuploads' } },
        }],
      };
    }
    return {
      items: [{
        id: 'PLresolved',
        snippet: { title: 'Resolved Playlist', channelId: 'UCowner', channelTitle: 'Owner' },
      }],
    };
  };

  const channel = await resolveYouTubeSource('@creator', { key: 'test-key', request });
  assert.equal(channel.canonicalId, 'UCresolved');
  assert.equal(channel.uploadsPlaylistId, 'UUuploads');
  assert.deepEqual(calls[0], {
    path: 'channels',
    params: { part: 'snippet,contentDetails', forHandle: 'creator' },
    key: 'test-key',
  });

  const playlist = await resolveYouTubeSource('PLrawPlaylist', { key: 'test-key', request });
  assert.deepEqual(playlist, {
    kind: 'youtube-playlist',
    canonicalId: 'PLresolved',
    playlistId: 'PLresolved',
    title: 'Resolved Playlist',
    channelId: 'UCowner',
    channelTitle: 'Owner',
  });
  assert.deepEqual(calls[1].params, {
    part: 'snippet,contentDetails',
    id: 'PLrawPlaylist',
  });
});

test('paginates, normalizes, deduplicates, and stops before the cursor', async () => {
  const calls = [];
  const request = async (path, params) => {
    calls.push({ path, params });
    if (!params.pageToken) {
      return {
        items: [
          playlistItem('new', '2026-08-14T00:00:00Z', {
            title: 'Newest',
            contentDetails: { videoPublishedAt: '2026-08-14T00:00:00Z' },
            snippet: { videoOwnerChannelId: 'UCowner', videoOwnerChannelTitle: 'Owner' },
          }),
          { snippet: { title: '[Private video]' }, contentDetails: {} },
        ],
        nextPageToken: 'page-2',
      };
    }
    return {
      items: [
        playlistItem('older', '2026-08-12T00:00:00Z'),
        playlistItem('new', '2026-08-14T00:00:00Z'),
        playlistItem('cursor', '2026-08-11T00:00:00Z'),
        playlistItem('ignored-after-cursor', '2026-08-10T00:00:00Z'),
      ],
      nextPageToken: 'not-requested',
    };
  };

  const result = await fetchPlaylistItems('UUuploads', {
    request,
    untilVideoId: 'cursor',
    maxPages: 5,
  });

  assert.equal(result.newestVideoId, 'new');
  assert.equal(result.cursorFound, true);
  assert.equal(result.pages, 2);
  assert.equal(result.quotaUnits, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items.map((item) => item.videoId), ['new', 'older']);
  assert.deepEqual(result.items[0], {
    videoId: 'new',
    url: 'https://www.youtube.com/watch?v=new',
    title: 'Newest',
    channelId: 'UCowner',
    channelTitle: 'Owner',
    publishedAt: '2026-08-14T00:00:00Z',
  });
  assert.deepEqual(calls.map((call) => call.params), [
    { part: 'snippet,contentDetails', playlistId: 'UUuploads', maxResults: 50 },
    {
      part: 'snippet,contentDetails',
      playlistId: 'UUuploads',
      maxResults: 50,
      pageToken: 'page-2',
    },
  ]);
});

test('reports a missing cursor and honors the page cap', async () => {
  const request = async (path, params) => ({
    items: [playlistItem(`video-${params.pageToken || 'one'}`, '2026-08-01T00:00:00Z')],
    nextPageToken: `next-${params.pageToken || 'one'}`,
  });
  const result = await fetchPlaylistItems('PLcap', {
    request,
    untilVideoId: 'not-present',
    maxPages: 2,
  });

  assert.equal(result.cursorFound, false);
  assert.equal(result.pages, 2);
  assert.equal(result.quotaUnits, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 2);
});

test('discoverWatch uses uploads playlist for channels and canonical ID for playlists', async () => {
  const seen = [];
  const request = async (path, params) => {
    seen.push(params.playlistId);
    return { items: [] };
  };

  await discoverWatch({ kind: 'youtube-channel', canonicalId: 'UCchannel', uploadsPlaylistId: 'UUuploads' }, { request });
  await discoverWatch({ kind: 'youtube-playlist', canonicalId: 'PLplaylist' }, { request });
  assert.deepEqual(seen, ['UUuploads', 'PLplaylist']);
});

test('enrich separates search calls from general list quota units', async () => {
  const request = async (path) => {
    if (path === 'videos') {
      return {
        items: [{
          id: 'known',
          snippet: { title: 'Known', channelTitle: 'Channel', publishedAt: '2026-08-01T00:00:00Z' },
        }],
      };
    }
    return {
      items: [{
        id: { videoId: 'searched' },
        snippet: { title: 'Searched title', channelTitle: 'Channel', publishedAt: '2026-08-02T00:00:00Z' },
      }],
    };
  };

  const result = await enrich(
    [{ title: 'Known', videoId: 'known' }, { title: 'Searched title' }],
    { request, budget: 1 },
  );

  assert.equal(result.searchesSpent, 1);
  assert.equal(result.searchCallsSpent, 1);
  assert.equal(result.quotaUnitsApprox, 2);
  assert.deepEqual(result.quota, {
    searchCalls: 1,
    searchRequestUnits: 1,
    listRequests: 1,
    listUnits: 1,
    totalRequestUnitsApprox: 2,
  });
});
