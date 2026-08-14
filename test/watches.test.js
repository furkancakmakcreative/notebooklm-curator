import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';

import {
  addWatch,
  approveCandidates,
  listCandidates,
  listWatches,
  manageWatches,
  startupCatchUp,
  syncWatches,
} from '../src/watches.js';
import { readState, updateState } from '../src/state.js';

const DAY = 24 * 60 * 60 * 1000;

function item(videoId, publishedAt, extra = {}) {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: extra.title || `Video ${videoId}`,
    channelId: extra.channelId || 'UCchannel',
    channelTitle: extra.channelTitle || 'Channel',
    publishedAt,
  };
}

async function harness({ now = Date.parse('2026-08-14T00:00:00.000Z'), discover, sourceCounts = {}, addSource, addResult, confirmAddResult = true, hasSource, containsSource } = {}) {
  const baseDir = await fs.mkdtemp(`${os.tmpdir()}\\nlm-watches-test-`);
  let clock = now;
  let nextId = 0;
  const calls = [];
  const counts = new Map(Object.entries(sourceCounts));
  const youtube = {
    async resolveYouTubeSource(input) {
      const isPlaylist = input.includes('playlist') || input.startsWith('PL');
      return isPlaylist
        ? { kind: 'youtube-playlist', canonicalId: input.replace(/.*list=/, ''), title: 'Playlist' }
        : {
            kind: 'youtube-channel',
            canonicalId: input,
            uploadsPlaylistId: `UU-${input}`,
            title: 'Channel',
          };
    },
    async discoverWatch(watch, options) {
      calls.push({ watchId: watch.id, kind: watch.kind, options });
      return (await discover?.(watch, options)) || { newestVideoId: null, items: [] };
    },
  };
  const notebooklm = {
    async getSourceCount({ notebookId }) {
      return counts.get(notebookId) || 0;
    },
    async addSource({ notebookId, url }) {
      if (addSource) await addSource({ notebookId, url, counts });
      counts.set(notebookId, (counts.get(notebookId) || 0) + 1);
      return addResult === undefined && confirmAddResult ? { added: true } : addResult;
    },
    ...(hasSource ? { async hasSource(input) { return hasSource(input); } } : {}),
    ...(containsSource ? { async containsSource(input) { return containsSource(input); } } : {}),
  };
  return {
    baseDir,
    calls,
    counts,
    setNow(value) {
      clock = typeof value === 'number' ? value : Date.parse(value);
    },
    deps: {
      baseDir,
      now: () => clock,
      randomUUID: () => `id-${++nextId}`,
      youtube,
      notebooklm,
      retryBaseMs: 100,
      retryMaxMs: 1000,
    },
    notebooklm,
  };
}

test('addWatch baselines without importing and initialItems is bounded and ordered', async () => {
  const h = await harness({
    discover: async () => ({
      newestVideoId: 'v3',
      items: [item('v3', '2026-08-13T00:00:00Z'), item('v2', '2026-08-12T00:00:00Z'), item('v1', '2026-08-11T00:00:00Z')],
    }),
  });
  const baseline = await addWatch({ source: 'UCbaseline', notebookId: 'n1' }, h.deps);
  assert.equal(baseline.initialCandidateCount, 0);
  assert.equal(baseline.watch.cursorVideoId, 'v3');

  const initial = await addWatch({ source: 'UCinitial', notebookId: 'n1', initialItems: 2 }, h.deps);
  assert.equal(initial.initialCandidateCount, 2);
  const candidates = await listCandidates({ watchId: initial.watch.id }, h.deps);
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.videoId), ['v2', 'v3']);
  await assert.rejects(
    addWatch({ source: 'UCbad', notebookId: 'n1', initialItems: 51 }, h.deps),
    /initialItems/,
  );

  const duplicate = await addWatch({ source: 'UCbaseline', notebookId: 'n1' }, h.deps);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.watch.id, baseline.watch.id);
  assert.equal((await listWatches({}, h.deps)).watches.length, 2);
});

test('sync uses a channel cursor, full-scans playlists, deduplicates, and inserts oldest first', async () => {
  const seen = [];
  const h = await harness({
    discover: async (watch, options) => {
      seen.push({ kind: watch.kind, until: options.untilVideoId });
      return {
        newestVideoId: 'newest',
        items: [item('newest', '2026-08-14T00:00:00Z'), item('middle', '2026-08-13T00:00:00Z'), item('old', '2026-08-12T00:00:00Z')],
      };
    },
  });
  const channel = await addWatch({ source: 'UCcursor', notebookId: 'n1' }, h.deps);
  const playlist = await addWatch({ source: 'PLplaylist', notebookId: 'n1' }, h.deps);
  await syncWatches({ watchId: channel.watch.id, force: true }, h.deps);
  await syncWatches({ watchId: playlist.watch.id, force: true }, h.deps);
  assert.equal(seen.at(-2).kind, 'youtube-channel');
  assert.equal(seen.at(-2).until, 'newest');
  assert.equal(seen.at(-1).kind, 'youtube-playlist');
  assert.equal(seen.at(-1).until, null);
  const candidates = await listCandidates({ watchId: channel.watch.id }, h.deps);
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.videoId), ['old', 'middle', 'newest']);
  const again = await syncWatches({ watchId: channel.watch.id, force: true }, h.deps);
  assert.equal(again.discovered, 0);
});

test('due, missed-run, and startup catch-up behavior use persisted success times', async () => {
  const h = await harness({ discover: async () => ({ newestVideoId: 'v', items: [] }) });
  const created = await addWatch({ source: 'UCdue', notebookId: 'n1', intervalHours: 2 }, h.deps);
  const first = await syncWatches({}, h.deps);
  assert.equal(first.watches.length, 1);
  h.setNow(Date.parse('2026-08-14T01:00:00Z'));
  assert.equal((await syncWatches({}, h.deps)).watches.length, 0);
  h.setNow(Date.parse('2026-08-14T05:00:00Z'));
  assert.equal((await syncWatches({}, h.deps)).watches.length, 1);
  h.setNow(Date.parse('2026-08-14T10:00:00Z'));
  const startup = await startupCatchUp({}, h.deps);
  assert.equal(startup.watches.length, 1);
  assert.equal((await readState('default', { baseDir: h.baseDir })).lastStartupCheckAt, '2026-08-14T10:00:00.000Z');
  assert.equal((await listWatches({ watchId: created.watch.id }, h.deps)).watches.length, 1);
});

test('report, review, and auto modes persist the right candidate behavior and age gate auto adds', async () => {
  const h = await harness({
    discover: async (watch) => ({
      newestVideoId: `${watch.notebookId}-new`,
      items: [item(`${watch.notebookId}-new`, '2026-08-13T00:00:00Z')],
    }),
  });
  const report = await addWatch({ source: 'UCreport', notebookId: 'report', mode: 'report' }, h.deps);
  const review = await addWatch({ source: 'UCreview', notebookId: 'review', mode: 'review' }, h.deps);
  const auto = await addWatch({ source: 'UCauto', notebookId: 'auto', mode: 'auto' }, h.deps);
  const result = await syncWatches({ force: true }, h.deps);
  assert.equal(result.added, 0);
  assert.equal(result.ageGated, 1);
  assert.equal((await listCandidates({ watchId: report.watch.id }, h.deps)).candidates[0].status, 'reported');
  assert.equal((await listCandidates({ watchId: review.watch.id }, h.deps)).candidates[0].status, 'pending');
  assert.equal((await listCandidates({ watchId: auto.watch.id }, h.deps)).candidates[0].status, 'pending');

  h.setNow('2026-08-17T00:00:00Z');
  const aged = await syncWatches({ watchId: auto.watch.id, force: true }, h.deps);
  assert.equal(aged.added, 1);
  assert.equal(h.counts.get('auto'), 1);
});

test('auto mode stops at configurable capacity and retries failures without blocking another watch', async () => {
  let failOnce = true;
  const discoveryCalls = new Map();
  const h = await harness({
    sourceCounts: { full: 1, flaky: 0 },
    addSource: async ({ notebookId }) => {
      if (notebookId === 'flaky' && failOnce) {
        failOnce = false;
        throw new Error('temporary add failure');
      }
    },
    discover: async (watch) => {
      const calls = (discoveryCalls.get(watch.notebookId) || 0) + 1;
      discoveryCalls.set(watch.notebookId, calls);
      if (watch.notebookId === 'broken' && calls > 1) throw new Error('discovery failure');
      return {
        newestVideoId: `${watch.notebookId}-v`,
        items: [item(`${watch.notebookId}-v`, '2026-08-01T00:00:00Z')],
      };
    },
  });
  const full = await addWatch({ source: 'UCfull', notebookId: 'full', mode: 'auto', sourceLimit: 2, reserveSlots: 1 }, h.deps);
  const flaky = await addWatch({ source: 'UCflaky', notebookId: 'flaky', mode: 'auto' }, h.deps);
  const broken = await addWatch({ source: 'UCbroken', notebookId: 'broken', mode: 'auto' }, h.deps);
  const first = await syncWatches({ force: true }, h.deps);
  assert.equal(first.capacityStops.length, 1);
  assert.equal(first.retries, 1);
  assert.equal(first.watchErrors.length, 1);
  assert.equal(first.watches.find((watch) => watch.watchId === broken.watch.id).error, 'discovery failure');
  assert.equal((await listCandidates({ watchId: flaky.watch.id }, h.deps)).candidates[0].status, 'retry');
  assert.equal((await listCandidates({ watchId: full.watch.id }, h.deps)).candidates[0].status, 'pending');

  h.counts.set('full', 0);
  h.setNow(Date.parse('2026-08-14T01:00:00Z'));
  const second = await syncWatches({ force: true }, h.deps);
  assert.ok(second.added >= 1);
});

test('approval requires confirmation, ignores age, respects capacity, and management is tracking-only', async () => {
  const h = await harness({ sourceCounts: { n1: 1 }, discover: async () => ({ newestVideoId: 'young', items: [item('young', '2026-08-13T00:00:00Z')] }) });
  const created = await addWatch({ source: 'UCmanage', notebookId: 'n1', mode: 'review', sourceLimit: 2, reserveSlots: 1 }, h.deps);
  await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  const candidateId = (await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].id;
  await assert.rejects(approveCandidates({ candidateIds: [candidateId], confirm: false }, h.deps), /confirm:true/);
  const blocked = await approveCandidates({ candidateIds: [candidateId], confirm: true }, h.deps);
  assert.deepEqual(blocked.capacityStops, [candidateId]);
  assert.equal((await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].status, 'pending');

  h.counts.set('n1', 0);
  const approved = await approveCandidates({ candidateIds: [candidateId], confirm: true }, h.deps);
  assert.deepEqual(approved.approved, [candidateId]);
  assert.equal(h.counts.get('n1'), 1);

  await manageWatches({ action: 'pause', watchId: created.watch.id }, h.deps);
  assert.equal((await listWatches({ watchId: created.watch.id }, h.deps)).watches[0].enabled, false);
  await manageWatches({ action: 'resume', watchId: created.watch.id }, h.deps);
  await manageWatches({ action: 'update', watchId: created.watch.id, mode: 'auto', sourceLimit: 4, reserveSlots: 1, notebookId: 'n2' }, h.deps);
  const updated = (await listWatches({ watchId: created.watch.id }, h.deps)).watches[0];
  assert.equal(updated.mode, 'auto');
  assert.equal(updated.notebookId, 'n2');
  await assert.rejects(manageWatches({ action: 'remove', watchId: created.watch.id, confirm: false }, h.deps), /confirm:true/);
  const removed = await manageWatches({ action: 'remove', watchId: created.watch.id, confirm: true }, h.deps);
  assert.equal(removed.removedCandidates, 1);
  assert.deepEqual((await listWatches({}, h.deps)).watches, []);
  assert.equal(h.counts.get('n1'), 1, 'remove never touches NotebookLM sources');
});

test('overlapping syncs claim candidates atomically and expired claims become uncertain', async () => {
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const h = await harness({
    discover: async () => ({ newestVideoId: 'overlap', items: [item('overlap', '2026-08-01T00:00:00Z')] }),
    addSource: async () => {
      entered();
      await releasePromise;
    },
  });
  const created = await addWatch({ source: 'UClock', notebookId: 'n1', mode: 'auto' }, h.deps);
  const first = syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  await enteredPromise;
  const second = syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  const secondResult = await second;
  release();
  await first;
  assert.equal(secondResult.added, 0);
  assert.equal(h.counts.get('n1'), 1);

  const state = await readState('default', { baseDir: h.baseDir });
  const candidate = Object.values(state.candidates)[0];
  await updateState('default', (current) => {
    const target = current.candidates[candidate.id];
    target.status = 'adding';
    target.claimUntilAt = '1970-01-01T00:00:00.000Z';
    target.claimToken = 'stale';
  }, { baseDir: h.baseDir, now: h.deps.now });
  const recovered = await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  assert.equal(recovered.added, 0);
  assert.equal(h.counts.get('n1'), 1);
  assert.equal((await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].status, 'uncertain');
});

test('truncated discovery persists candidates but does not advance cursor or success', async () => {
  const optionsSeen = [];
  let syncCall = 0;
  let initialDiscovery = true;
  const h = await harness({
    discover: async (watch, options) => {
      optionsSeen.push(options);
      if (initialDiscovery) {
        initialDiscovery = false;
        return { newestVideoId: 'baseline', items: [] };
      }
      syncCall++;
      return syncCall === 1
        ? { newestVideoId: 'truncated-new', items: [item('truncated-new', '2026-08-13T00:00:00Z')], truncated: true, maxPages: 1 }
        : { newestVideoId: 'complete-new', items: [item('complete-new', '2026-08-14T00:00:00Z')] };
    },
  });
  const created = await addWatch({ source: 'UCtruncated', notebookId: 'n1' }, h.deps);
  const baselineCursor = (await listWatches({ watchId: created.watch.id }, h.deps)).watches[0].cursorVideoId;
  const result = await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  const afterTruncated = await listWatches({ watchId: created.watch.id }, h.deps);
  assert.equal(result.watches[0].truncated, true);
  assert.match(afterTruncated.watches[0].lastError, /increase maxPages/);
  assert.equal(afterTruncated.watches[0].cursorVideoId, baselineCursor);
  assert.equal(afterTruncated.watches[0].lastSuccessAt, null);
  assert.equal((await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].videoId, 'truncated-new');

  await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  assert.equal(optionsSeen.at(-1).untilVideoId, baselineCursor, 'a truncated run must not skip the cursor boundary');
});

test('notebook-level claims serialize concurrent watches and suppress duplicate sources', async () => {
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  let adds = 0;
  const h = await harness({
    discover: async (watch) => ({
      newestVideoId: watch.canonicalId === 'UCone' ? 'same' : 'other',
      items: [item(watch.canonicalId === 'UCone' ? 'same' : 'other', '2026-08-01T00:00:00Z')],
    }),
    addSource: async () => {
      adds++;
      entered();
      await releasePromise;
    },
  });
  const first = await addWatch({ source: 'UCone', notebookId: 'shared', mode: 'auto', minAutoAddAgeHours: 0, sourceLimit: 1, reserveSlots: 0 }, h.deps);
  const second = await addWatch({ source: 'UCtwo', notebookId: 'shared', mode: 'auto', minAutoAddAgeHours: 0, sourceLimit: 1, reserveSlots: 0 }, h.deps);
  const runOne = syncWatches({ watchId: first.watch.id, force: true }, h.deps);
  await enteredPromise;
  const runTwo = syncWatches({ watchId: second.watch.id, force: true }, h.deps);
  const secondResult = await runTwo;
  release();
  await runOne;
  assert.equal(secondResult.added, 0);
  assert.equal(adds, 1, 'a one-slot notebook must not receive concurrent additions');
  assert.equal(h.counts.get('shared'), 1);

  const duplicate = await addWatch({ source: 'UCduplicate', notebookId: 'shared', mode: 'auto', minAutoAddAgeHours: 0, initialItems: 1 }, h.deps);
  await updateState('default', (state) => {
    const candidate = Object.values(state.candidates).find((entry) => entry.watchId === duplicate.watch.id);
    candidate.sourceKey = 'youtube:same';
    candidate.videoId = 'same';
  }, { baseDir: h.baseDir, now: h.deps.now });
  const duplicateCandidates = (await listCandidates({ watchId: duplicate.watch.id }, h.deps)).candidates;
  const duplicateId = duplicateCandidates.find((candidate) => candidate.sourceKey === 'youtube:same').id;
  await approveCandidates({ candidateIds: [duplicateId], confirm: true }, h.deps);
  assert.equal((await listCandidates({ watchId: duplicate.watch.id }, h.deps)).candidates.find((candidate) => candidate.id === duplicateId).status, 'ignored');
});

test('uncertain approval reconciles before retrying and cannot add without reconciliation', async () => {
  let addCalls = 0;
  const h = await harness({
    hasSource: async () => false,
    addSource: async () => { addCalls++; },
    discover: async () => ({ newestVideoId: 'uncertain', items: [item('uncertain', '2026-08-01T00:00:00Z')] }),
  });
  const created = await addWatch({ source: 'UCuncertain', notebookId: 'n1', mode: 'review' }, h.deps);
  await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  const candidateId = (await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].id;
  await updateState('default', (state) => {
    const candidate = state.candidates[candidateId];
    candidate.status = 'uncertain';
    candidate.lastError = 'add claim expired; explicit approval required to reconcile';
  }, { baseDir: h.baseDir, now: h.deps.now });
  const approved = await approveCandidates({ candidateIds: [candidateId], confirm: true }, h.deps);
  assert.deepEqual(approved.approved, [candidateId]);
  assert.equal(addCalls, 1);

  const noReconcile = await harness({ discover: async () => ({ newestVideoId: 'x', items: [item('x', '2026-08-01T00:00:00Z')] }) });
  const noReconcileWatch = await addWatch({ source: 'UCnoreconcile', notebookId: 'n2', mode: 'review' }, noReconcile.deps);
  await syncWatches({ watchId: noReconcileWatch.watch.id, force: true }, noReconcile.deps);
  const noReconcileId = (await listCandidates({ watchId: noReconcileWatch.watch.id }, noReconcile.deps)).candidates[0].id;
  await updateState('default', (state) => { state.candidates[noReconcileId].status = 'uncertain'; }, { baseDir: noReconcile.baseDir, now: noReconcile.deps.now });
  const blocked = await approveCandidates({ candidateIds: [noReconcileId], confirm: true }, noReconcile.deps);
  assert.equal(blocked.approved.length, 0);
  assert.match(blocked.errors[0].error, /reconcile/);
  assert.equal((await listCandidates({ watchId: noReconcileWatch.watch.id }, noReconcile.deps)).candidates[0].status, 'uncertain');
});

test('approval reconciles a claim that expires during the approval call', async () => {
  const h = await harness({
    discover: async () => ({
      newestVideoId: 'expired-during-approval',
      items: [item('expired-during-approval', '2026-08-01T00:00:00Z')],
    }),
  });
  h.deps.notebooklm.hasSource = async () => true;
  const created = await addWatch({ source: 'UCexpired-approval', notebookId: 'n1' }, h.deps);
  await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  const candidate = (await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0];
  await updateState('default', (state) => {
    Object.assign(state.candidates[candidate.id], {
      status: 'adding',
      claimToken: 'dead-process',
      claimUntilAt: '1970-01-01T00:00:00.000Z',
    });
  }, { baseDir: h.baseDir, now: h.deps.now });

  const result = await approveCandidates({ candidateIds: [candidate.id], confirm: true }, h.deps);
  assert.deepEqual(result.approved, [candidate.id]);
  assert.equal((await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].status, 'added');
  assert.equal(h.counts.get('n1') || 0, 0, 'reconciliation does not add a duplicate source');
});

test('add adapters must confirm added:true and live claims renew until add completes', async () => {
  let clock = Date.parse('2026-08-14T00:00:00Z');
  let addCalls = 0;
  const h = await harness({
    now: clock,
    addSource: async () => {
      addCalls++;
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
    confirmAddResult: false,
    discover: async () => ({ newestVideoId: 'strict', items: [item('strict', '2026-08-01T00:00:00Z')] }),
  });
  h.deps.claimLeaseMs = 30;
  const created = await addWatch({ source: 'UCstrict', notebookId: 'n1', mode: 'auto', minAutoAddAgeHours: 0 }, h.deps);
  const result = await syncWatches({ watchId: created.watch.id, force: true }, h.deps);
  assert.equal(result.retries, 1);
  assert.equal(addCalls, 1);
  assert.equal((await listCandidates({ watchId: created.watch.id }, h.deps)).candidates[0].status, 'retry');
  void clock;
});
