import assert from 'node:assert/strict';
import test from 'node:test';

import { checkApiKey, discoverWatch, enrich, explainApiError, resolveYouTubeSource } from '../src/youtube.js';
import { setupReport } from '../src/index.js';

// Response bodies in the shape the YouTube Data API returns them.
const BODIES = {
  invalid: {
    status: 400,
    body: {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        errors: [{ message: 'API key not valid. Please pass a valid API key.', domain: 'global', reason: 'badRequest' }],
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
      },
    },
  },
  disabled: {
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'YouTube Data API v3 has not been used in project 123456 before or it is disabled.',
        errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }],
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'SERVICE_DISABLED' }],
      },
    },
  },
  quota: {
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'The request cannot be completed because you have exceeded your quota.',
        errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }],
      },
    },
  },
  blocked: {
    status: 403,
    body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } },
  },
  referrer: {
    status: 403,
    body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } },
  },
};

function withFetch(response, fn) {
  const original = globalThis.fetch;
  const previousKey = process.env.YOUTUBE_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  process.env.YOUTUBE_API_KEY = 'AIzaTESTKEY';
  return Promise.resolve(fn(() => calls)).finally(() => {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  });
}

test('each common key failure gets a plain explanation and a concrete fix', () => {
  const expected = { invalid: 'invalid-key', disabled: 'api-disabled', quota: 'quota', blocked: 'api-blocked', referrer: 'app-restricted' };
  for (const [name, code] of Object.entries(expected)) {
    const { status, body } = BODIES[name];
    const problem = explainApiError(status, JSON.stringify(body));
    assert.equal(problem?.code, code, name);
    assert.ok(problem.fix.length > 20, `${name} has a fix`);
    assert.ok(!/project 123456/.test(problem.message + problem.fix), 'no raw Google text');
  }
  assert.equal(explainApiError(500, 'Internal error'), null);
  assert.equal(explainApiError(404, JSON.stringify({ error: { errors: [{ reason: 'playlistNotFound' }] } })), null);
});

test('an audit stops at the first key failure and says why once', async () => {
  await withFetch(BODIES.disabled, async (calls) => {
    const result = await enrich(
      [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
      { budget: 60 },
    );
    assert.equal(calls(), 1, 'no more calls after the key failed');
    assert.equal(result.youtubeProblem.code, 'api-disabled');
    assert.match(result.youtubeProblem.fix, /Enable/);
    assert.ok(!JSON.stringify(result).includes('AIzaTESTKEY'));
  });
});

test('watches fall back to the public feed when the key is broken', async () => {
  const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
  const feed = `<feed><title>Dev</title><entry><yt:videoId>vid00000001</yt:videoId><title>New</title><published>2026-09-20T00:00:00Z</published></entry></feed>`;
  await withFetch(BODIES.invalid, async () => {
    const fetchText = async () => feed;
    const resolved = await resolveYouTubeSource(CHANNEL, { fetchText });
    assert.equal(resolved.via, 'rss');
    assert.equal(resolved.youtubeProblem.code, 'invalid-key');
    assert.match(resolved.warning, /Used the public feed instead/);

    const found = await discoverWatch(
      { kind: 'youtube-channel', canonicalId: CHANNEL, uploadsPlaylistId: 'UU_x', cursorVideoId: null },
      { fetchText, untilVideoId: null },
    );
    assert.deepEqual(found.items.map((item) => item.videoId), ['vid00000001']);
    assert.match(found.warning, /not valid/);
  });
});

test('setup tests a configured key and explains a broken one without blocking', async () => {
  await withFetch(BODIES.blocked, async () => {
    const check = await checkApiKey();
    assert.equal(check.status, 'problem');
    assert.equal(check.code, 'api-blocked');
  });
  const report = await setupReport({}, {
    platform: 'darwin',
    chromeInstalled: () => true,
    hasApiKey: () => true,
    checkApiKey: async () => ({ status: 'problem', code: 'quota', message: 'YouTube API key problem: quota used up.', fix: 'It resets at midnight Pacific time.' }),
    listWatches: async () => ({ watches: [] }),
    checkSignIn: async () => true,
  });
  assert.equal(report.ready, true, 'the key is optional');
  assert.equal(report.checks.youtubeApiKey, 'set but not working (quota)');
  assert.match(report.nextSteps.join(' '), /midnight Pacific.*Everything else works without the key/);
});
