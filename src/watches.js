import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import * as stateDefaults from './state.js';
import * as youtubeDefaults from './youtube.js';

const DEFAULTS = {
  account: 'default',
  mode: 'review',
  intervalHours: 48,
  sourceLimit: 50,
  reserveSlots: 5,
  minAutoAddAgeHours: 72,
  initialItems: 0,
  maxPages: 10,
  claimLeaseMs: 30 * 60 * 1000,
  retryBaseMs: 60 * 60 * 1000,
  retryMaxMs: 24 * 60 * 60 * 1000,
};

const MODES = new Set(['report', 'review', 'auto']);
const KINDS = new Set(['youtube-channel', 'youtube-playlist']);
const CANDIDATE_STATUSES = new Set(['reported', 'pending', 'retry', 'adding', 'uncertain', 'added', 'ignored']);
const MANAGE_ACTIONS = new Set(['list', 'pause', 'resume', 'update', 'remove']);

// A claim is persisted in the manifest. This protects the add side effect even
// when two sync calls discover the same candidate at the same time, and lets a
// later call recover a process that died while holding a claim.
const CLAIM_STATUS = 'adding';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error) {
  let text = String(error?.message || error);
  const secrets = [
    homedir(),
    process.env.NLM_DATA_DIR,
    process.env.YOUTUBE_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.API_KEY,
  ].filter((value) => typeof value === 'string' && value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/([?&]key=)[^&\s]+/gi, '$1REDACTED')
    .replace(/(api[_-]?key[=:]\s*)[^\s&]+/gi, '$1REDACTED')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowMs(deps = {}) {
  const clock = deps.now ?? deps.clock;
  const value = typeof clock === 'function' ? clock() : clock;
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  throw new TypeError('deps.now must return a Date, ISO timestamp, or finite timestamp');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function uuid(deps) {
  const make = deps.randomUUID || deps.uuid || nodeRandomUUID;
  const value = make();
  if (typeof value !== 'string' || !value) throw new TypeError('deps.randomUUID must return a string');
  return value;
}

function accountOf(input = {}, deps = {}) {
  const account = input.account ?? deps.account ?? DEFAULTS.account;
  const normalize = deps.state?.normalizeAccount || stateDefaults.normalizeAccount;
  return normalize(account);
}

function stateOptions(deps, clockMs) {
  const options = { ...(deps.stateOptions || {}) };
  if (deps.baseDir !== undefined) options.baseDir = deps.baseDir;
  if (deps.now !== undefined || deps.clock !== undefined) options.now = () => clockMs;
  return options;
}

function stateApi(deps = {}) {
  const api = deps.state || (deps.readState && deps.updateState ? deps : stateDefaults);
  if (typeof api.readState !== 'function' || typeof api.updateState !== 'function') {
    throw new TypeError('deps.state must provide readState and updateState');
  }
  return api;
}

async function read(account, deps = {}) {
  const clock = nowMs(deps);
  return stateApi(deps).readState(account, stateOptions(deps, clock));
}

async function update(account, deps, updater) {
  const clock = nowMs(deps);
  return stateApi(deps).updateState(account, updater, stateOptions(deps, clock));
}

function youtubeApi(deps = {}) {
  const api = deps.youtube || deps.yt || deps.youtubeAdapter || youtubeDefaults;
  if (typeof api.resolveYouTubeSource !== 'function' || typeof api.discoverWatch !== 'function') {
    throw new TypeError('deps.youtube must provide resolveYouTubeSource and discoverWatch');
  }
  return api;
}

function youtubeOptions(deps = {}) {
  return { ...(deps.youtubeOptions || {}) };
}

function notebookApi(deps = {}) {
  return deps.notebooklm || deps.notebook || deps.notebookAdapter || null;
}

let defaultNotebookApiPromise;
async function defaultNotebookApi() {
  if (!defaultNotebookApiPromise) {
    defaultNotebookApiPromise = Promise.all([import('./browser.js'), import('./notebooklm.js')]).then(
      ([browser, notebooklm]) => ({
        async getSourceCount({ account, notebookId }) {
          const page = await browser.getPage({ account });
          await notebooklm.gotoNotebook(page, notebookId);
          return (await notebooklm.listSources(page)).length;
        },
        async addSource({ account, notebookId, url }) {
          const page = await browser.getPage({ account });
          await notebooklm.gotoNotebook(page, notebookId);
          const before = (await notebooklm.listSources(page)).length;
          await notebooklm.addSource(page, url);
          const after = (await notebooklm.listSources(page)).length;
          if (after !== before + 1) {
            throw new Error(`NotebookLM source count did not increase (${before} to ${after})`);
          }
          return { added: true, before, after };
        },
        async hasSource({ account, notebookId, candidate, title }) {
          const page = await browser.getPage({ account });
          await notebooklm.gotoNotebook(page, notebookId);
          const targetTitle = title ?? candidate?.title;
          return (await notebooklm.listSources(page)).some((source) => source.title === targetTitle);
        },
      }),
    );
  }
  return defaultNotebookApiPromise;
}

async function getNotebookApi(deps) {
  return notebookApi(deps) || defaultNotebookApi();
}

async function sourceCount(api, input) {
  const fn = api.getSourceCount || api.sourceCount || api.countSources || api.count || api.listSources;
  if (typeof fn !== 'function') {
    throw new TypeError('NotebookLM adapter must provide getSourceCount or countSources');
  }
  const value = await fn.call(api, input);
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (isObject(value)) {
    const count = value.sourceCount ?? value.count;
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return count;
  }
  throw new TypeError('NotebookLM source count must be a non-negative integer');
}

async function addNotebookSource(api, input) {
  const fn = api.addSource || api.add;
  if (typeof fn !== 'function') throw new TypeError('NotebookLM adapter must provide addSource');
  const result = await fn.call(api, input);
  if (!isObject(result) || result.added !== true) {
    throw new Error((isObject(result) && result.reason) || 'NotebookLM add did not confirm added:true');
  }
  return result;
}

async function reconcileNotebookSource(api, input) {
  const fn = api.hasSource || api.containsSource;
  if (typeof fn !== 'function') {
    throw new Error('NotebookLM adapter cannot reconcile an uncertain add');
  }
  const result = await fn.call(api, input);
  if (typeof result === 'boolean') return result;
  if (isObject(result)) {
    const present = result.present ?? result.hasSource ?? result.containsSource;
    if (typeof present === 'boolean') return present;
  }
  throw new TypeError('NotebookLM reconciliation must return a boolean');
}

function stringRequired(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function numberValue(value, name, { integer = false, min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min) {
    throw new TypeError(`${name} must be a ${integer ? 'integer' : 'number'} >= ${min}`);
  }
  return value;
}

function policyFrom(input = {}, base = DEFAULTS) {
  const policy = {
    mode: input.mode ?? base.mode,
    intervalHours: input.intervalHours ?? base.intervalHours,
    sourceLimit: input.sourceLimit ?? base.sourceLimit,
    reserveSlots: input.reserveSlots ?? base.reserveSlots,
    minAutoAddAgeHours: input.minAutoAddAgeHours ?? base.minAutoAddAgeHours,
  };
  if (!MODES.has(policy.mode)) throw new TypeError('mode must be report, review, or auto');
  numberValue(policy.intervalHours, 'intervalHours', { min: 1 });
  numberValue(policy.sourceLimit, 'sourceLimit', { integer: true, min: 1 });
  numberValue(policy.reserveSlots, 'reserveSlots', { integer: true, min: 0 });
  numberValue(policy.minAutoAddAgeHours, 'minAutoAddAgeHours', { min: 0 });
  if (policy.reserveSlots >= policy.sourceLimit) {
    throw new RangeError('reserveSlots must be below sourceLimit');
  }
  return policy;
}

function sourceInput(input = {}) {
  return input.inputUrl ?? input.source ?? input.url;
}

function candidateKey(watchId, videoId) {
  return `${watchId}|youtube:${videoId}`;
}

function sourceKey(videoId) {
  return `youtube:${videoId}`;
}

function candidateStatusFor(mode) {
  return mode === 'report' ? 'reported' : 'pending';
}

function findMatchingWatch(state, resolved, notebookId) {
  return Object.values(state.watches).find(
    (watch) =>
      watch.kind === resolved.kind &&
      watch.canonicalId === resolved.canonicalId &&
      watch.notebookId === notebookId,
  );
}

function comparePublished(a, b) {
  const at = Date.parse(a.publishedAt || '');
  const bt = Date.parse(b.publishedAt || '');
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
  return String(a.videoId).localeCompare(String(b.videoId));
}

function publicWatch(watch) {
  return { ...watch };
}

function publicCandidate(candidate) {
  const { claimToken, claimUntilAt, ...safe } = candidate;
  void claimToken;
  void claimUntilAt;
  return { ...safe };
}

function due(watch, atMs) {
  if (!watch.lastSuccessAt) return true;
  const last = Date.parse(watch.lastSuccessAt);
  return !Number.isFinite(last) || atMs - last >= watch.intervalHours * 60 * 60 * 1000;
}

function selectedWatches(state, input, atMs) {
  const watchId = input.watchId;
  if (watchId !== undefined) stringRequired(watchId, 'watchId');
  const all = Object.values(state.watches).filter((watch) =>
    watchId === undefined || watch.id === watchId,
  );
  if (watchId !== undefined && !all.length) throw new Error(`watch not found: ${watchId}`);
  return all.filter((watch) => watch.enabled && (input.force === true || due(watch, atMs)));
}

function retryDelay(deps, attempts) {
  const base = deps.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const max = deps.retryMaxMs ?? DEFAULTS.retryMaxMs;
  numberValue(base, 'deps.retryBaseMs', { min: 0 });
  numberValue(max, 'deps.retryMaxMs', { min: 0 });
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function assertCandidateStatus(status) {
  if (!CANDIDATE_STATUSES.has(status)) throw new TypeError(`invalid candidate status: ${status}`);
}

async function markWatchAttempt(account, watchId, deps, at) {
  await update(account, deps, (state) => {
    const watch = state.watches[watchId];
    if (watch) {
      watch.lastAttemptAt = iso(at);
      watch.lastError = null;
    }
  });
}

async function markWatchFailure(account, watchId, deps, at, error) {
  await update(account, deps, (state) => {
    const watch = state.watches[watchId];
    if (watch) {
      watch.lastAttemptAt = iso(at);
      watch.lastError = errorText(error);
    }
  });
}

function discoveryOptions(watch, input, deps) {
  const options = {
    ...youtubeOptions(deps),
    maxPages: input.maxPages ?? deps.maxPages ?? DEFAULTS.maxPages,
  };
  // Playlists can reorder, so cursor-based pagination is deliberately disabled.
  options.untilVideoId = watch.kind === 'youtube-playlist' ? null : watch.cursorVideoId || null;
  return options;
}

async function discoverForWatch(watch, input, deps) {
  const maxPages = input.maxPages ?? deps.maxPages ?? DEFAULTS.maxPages;
  numberValue(maxPages, 'maxPages', { integer: true, min: 1 });
  return {
    ...await youtubeApi(deps).discoverWatch(watch, discoveryOptions(watch, input, deps)),
    maxPages,
  };
}

async function persistDiscovery(account, watch, discovery, deps, at) {
  const discovered = [];
  const ordered = [...(discovery.items || [])].sort(comparePublished);
  const truncated = discovery.truncated === true;
  const maxPages = discovery.maxPages ?? null;
  const warning = `discovery truncated; increase maxPages${maxPages ? ` (currently ${maxPages})` : ''}`;
  await update(account, deps, (state) => {
    const current = state.watches[watch.id];
    if (!current) throw new Error(`watch not found: ${watch.id}`);
    for (const item of ordered) {
      if (!item?.videoId) continue;
      if (Object.values(state.candidates).some((candidate) =>
        candidate.watchId === watch.id && candidate.sourceKey === sourceKey(item.videoId))) continue;
      const candidate = {
        id: uuid(deps),
        watchId: watch.id,
        sourceKey: sourceKey(item.videoId),
        videoId: item.videoId,
        url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
        title: item.title || null,
        channelId: item.channelId || null,
        channelTitle: item.channelTitle || null,
        publishedAt: item.publishedAt || null,
        discoveredAt: iso(at),
        status: candidateStatusFor(current.mode),
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        addedAt: null,
      };
      state.candidates[candidate.id] = candidate;
      discovered.push(candidate.id);
    }
    if (truncated) {
      current.lastError = warning;
    } else {
      current.cursorVideoId = discovery.newestVideoId || current.cursorVideoId || null;
      current.lastSuccessAt = iso(at);
      current.lastError = null;
    }
  });
  return { ids: discovered, warning: truncated ? warning : null };
}

function eligibleForAuto(candidate, watch, atMs) {
  if (!['pending', 'reported', 'retry'].includes(candidate.status)) return false;
  if (candidate.status === 'retry' && candidate.nextAttemptAt) {
    const next = Date.parse(candidate.nextAttemptAt);
    if (Number.isFinite(next) && next > atMs) return false;
  }
  const published = Date.parse(candidate.publishedAt || '');
  if (!Number.isFinite(published)) return false;
  return atMs - published >= watch.minAutoAddAgeHours * 60 * 60 * 1000;
}

function candidateAgeEligible(candidate, watch, atMs) {
  const published = Date.parse(candidate.publishedAt || '');
  return Number.isFinite(published) && atMs - published >= watch.minAutoAddAgeHours * 60 * 60 * 1000;
}

function expireClaimsInState(state, atMs) {
  for (const candidate of Object.values(state.candidates)) {
    if (candidate.status !== CLAIM_STATUS) continue;
    const until = candidate.claimUntilAt && Date.parse(candidate.claimUntilAt);
    if (!until || until <= atMs) {
      candidate.status = 'uncertain';
      candidate.claimToken = undefined;
      candidate.claimUntilAt = undefined;
      candidate.nextAttemptAt = null;
      candidate.lastError = 'add claim expired; explicit approval required to reconcile';
    }
  }
}

async function renewClaim(account, claimed, deps) {
  await update(account, deps, (state) => {
    const candidate = state.candidates[claimed.id];
    if (candidate?.status === CLAIM_STATUS && candidate.claimToken === claimed.claimToken) {
      candidate.claimUntilAt = iso(nowMs(deps) + (deps.claimLeaseMs ?? DEFAULTS.claimLeaseMs));
    }
  });
}

function startClaimLeaseRenewal(account, claimed, deps) {
  const leaseMs = deps.claimLeaseMs ?? DEFAULTS.claimLeaseMs;
  const intervalMs = Math.max(10, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void renewClaim(account, claimed, deps).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function claimCandidate(account, candidateId, deps, atMs, { ignoreAge = false, allowUncertain = false } = {}) {
  const token = uuid(deps);
  let claimed = null;
  await update(account, deps, (state) => {
    expireClaimsInState(state, atMs);
    const candidate = state.candidates[candidateId];
    if (!candidate) return;
    const watch = state.watches[candidate.watchId];
    if (!watch) return;
    const wasUncertain = candidate.status === 'uncertain';
    const statusAvailable = ['pending', 'reported', 'retry'].includes(candidate.status) ||
      (allowUncertain && candidate.status === 'uncertain');
    if (!statusAvailable) return;
    const duplicate = Object.values(state.candidates).find((other) =>
      other.id !== candidate.id &&
      other.sourceKey === candidate.sourceKey &&
      state.watches[other.watchId]?.notebookId === watch.notebookId &&
      other.status === 'added',
    );
    if (duplicate) {
      candidate.status = 'ignored';
      candidate.nextAttemptAt = null;
      candidate.lastError = 'duplicate source already added to target notebook';
      return;
    }
    const notebookClaim = Object.values(state.candidates).some((other) =>
      other.id !== candidate.id &&
      other.status === CLAIM_STATUS &&
      state.watches[other.watchId]?.notebookId === watch.notebookId,
    );
    if (notebookClaim) return;
    if (!ignoreAge && !eligibleForAuto(candidate, watch, atMs)) return;
    if (!ignoreAge && !candidateAgeEligible(candidate, watch, atMs)) return;
    candidate.status = CLAIM_STATUS;
    candidate.claimToken = token;
    candidate.claimUntilAt = iso(atMs + (deps.claimLeaseMs ?? DEFAULTS.claimLeaseMs));
    claimed = { ...candidate, watch: { ...watch }, reconcileUncertain: wasUncertain };
  });
  return claimed;
}

async function releaseClaim(account, candidateId, token, deps, status = 'pending') {
  await update(account, deps, (state) => {
    const candidate = state.candidates[candidateId];
    if (candidate?.status === CLAIM_STATUS && candidate.claimToken === token) {
      candidate.status = status;
      candidate.claimToken = undefined;
      candidate.claimUntilAt = undefined;
    }
  });
}

async function finishCandidate(account, claimed, deps, outcome, atMs, error) {
  await update(account, deps, (state) => {
    const candidate = state.candidates[claimed.id];
    if (!candidate || candidate.claimToken !== claimed.claimToken) return;
    candidate.attempts = (candidate.attempts || 0) + 1;
    candidate.claimToken = undefined;
    candidate.claimUntilAt = undefined;
    if (outcome === 'added') {
      candidate.status = 'added';
      candidate.addedAt = iso(atMs);
      candidate.nextAttemptAt = null;
      candidate.lastError = null;
    } else if (outcome === 'uncertain') {
      candidate.status = 'uncertain';
      candidate.nextAttemptAt = null;
      candidate.lastError = errorText(error);
    } else {
      candidate.status = 'retry';
      candidate.nextAttemptAt = iso(atMs + retryDelay(deps, candidate.attempts));
      candidate.lastError = errorText(error);
    }
  });
}

async function addClaimedCandidate(account, claimed, deps, atMs, summary) {
  const notebookInput = {
    account,
    notebookId: claimed.watch.notebookId,
    url: claimed.url,
    candidate: publicCandidate(claimed),
    watch: claimed.watch,
  };
  let stopRenewal = () => {};
  let outcome = 'retry';
  let failure;
  try {
    const api = await getNotebookApi(deps);
    if (claimed.reconcileUncertain) {
      const present = await reconcileNotebookSource(api, notebookInput);
      if (present) {
        outcome = 'added';
      } else {
        const before = await sourceCount(api, notebookInput);
        const threshold = claimed.watch.sourceLimit - claimed.watch.reserveSlots;
        if (before >= threshold) {
          await releaseClaim(account, claimed.id, claimed.claimToken, deps, claimed.reconcileUncertain ? 'uncertain' : 'pending');
          summary.capacityStop = true;
          summary.capacityStops.push(claimed.id);
          return false;
        }
        stopRenewal = startClaimLeaseRenewal(account, claimed, deps);
        await addNotebookSource(api, notebookInput);
        outcome = 'added';
      }
    } else {
      const before = await sourceCount(api, notebookInput);
      const threshold = claimed.watch.sourceLimit - claimed.watch.reserveSlots;
      if (before >= threshold) {
        await releaseClaim(account, claimed.id, claimed.claimToken, deps);
        summary.capacityStop = true;
        summary.capacityStops.push(claimed.id);
        return false;
      }
      stopRenewal = startClaimLeaseRenewal(account, claimed, deps);
      await addNotebookSource(api, notebookInput);
      outcome = 'added';
    }
  } catch (error) {
    failure = error;
  } finally {
    stopRenewal();
  }
  if (outcome === 'added') {
    await finishCandidate(account, claimed, deps, 'added', atMs);
    summary.added++;
    summary.addedCandidateIds.push(claimed.id);
    return true;
  }
  await finishCandidate(account, claimed, deps, claimed.reconcileUncertain ? 'uncertain' : 'retry', atMs, failure);
  summary.retries += claimed.reconcileUncertain ? 0 : 1;
  summary.candidateErrors.push({ candidateId: claimed.id, error: errorText(failure) });
  return false;
}

async function autoProcess(account, watch, deps, atMs) {
  const summary = {
    added: 0,
    retries: 0,
    ageGated: 0,
    capacityStop: false,
    capacityStops: [],
    addedCandidateIds: [],
    candidateErrors: [],
  };
  await update(account, deps, (state) => expireClaimsInState(state, atMs));
  const current = await read(account, deps);
  const candidates = Object.values(current.candidates)
    .filter((candidate) => candidate.watchId === watch.id)
    .sort(comparePublished);
  for (const candidate of candidates) {
    if (!['pending', 'reported', 'retry', CLAIM_STATUS].includes(candidate.status)) continue;
    if (candidate.status === CLAIM_STATUS && candidate.claimUntilAt && Date.parse(candidate.claimUntilAt) > atMs) {
      continue;
    }
    if (!candidateAgeEligible(candidate, watch, atMs)) {
      summary.ageGated++;
      continue;
    }
    if (candidate.status === 'retry' && candidate.nextAttemptAt && Date.parse(candidate.nextAttemptAt) > atMs) {
      continue;
    }
    const claimed = await claimCandidate(account, candidate.id, deps, atMs);
    if (!claimed) continue;
    const added = await addClaimedCandidate(account, claimed, deps, atMs, summary);
    if (!added && summary.capacityStop) break;
  }
  return summary;
}

async function syncOne(account, watch, input, deps) {
  const attemptAt = nowMs(deps);
  const result = {
    watchId: watch.id,
    discovered: 0,
    added: 0,
    retries: 0,
    ageGated: 0,
    capacityStop: false,
    capacityStops: [],
    addedCandidateIds: [],
    candidateErrors: [],
    error: null,
  };
  await markWatchAttempt(account, watch.id, deps, attemptAt);
  try {
    const discovery = await discoverForWatch(watch, input, deps);
    const persisted = await persistDiscovery(account, watch, discovery, deps, nowMs(deps));
    result.discovered = persisted.ids.length;
    if (persisted.warning) {
      result.error = persisted.warning;
      result.truncated = true;
    }
  } catch (error) {
    result.error = errorText(error);
    await markWatchFailure(account, watch.id, deps, nowMs(deps), error);
    return result;
  }
  if (watch.mode === 'auto') {
    const auto = await autoProcess(account, watch, deps, nowMs(deps));
    Object.assign(result, auto);
  }
  return result;
}

function emptySyncSummary(account, atMs) {
  return {
    account,
    checkedAt: iso(atMs),
    watches: [],
    discovered: 0,
    added: 0,
    retries: 0,
    ageGated: 0,
    capacityStops: [],
    watchErrors: [],
    addedCandidateIds: [],
  };
}

export async function addWatch(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const account = accountOf(input, deps);
  const inputUrl = stringRequired(sourceInput(input), 'inputUrl');
  const notebookId = stringRequired(input.notebookId, 'notebookId');
  const policy = policyFrom(input);
  const initialItems = input.initialItems === undefined ? DEFAULTS.initialItems : input.initialItems;
  numberValue(initialItems, 'initialItems', { integer: true, min: 0 });
  if (initialItems > 50) throw new RangeError('initialItems must be between 0 and 50');

  const resolved = await youtubeApi(deps).resolveYouTubeSource(inputUrl, youtubeOptions(deps));
  if (!resolved || !KINDS.has(resolved.kind) || !resolved.canonicalId) {
    throw new Error('YouTube source resolution returned an invalid source');
  }
  const beforeDiscovery = await read(account, deps);
  const existingWatch = findMatchingWatch(beforeDiscovery, resolved, notebookId);
  if (existingWatch) {
    return {
      watch: publicWatch(existingWatch),
      existing: true,
      initialCandidateCount: 0,
      initialCandidateIds: Object.values(beforeDiscovery.candidates)
        .filter((candidate) => candidate.watchId === existingWatch.id)
        .map((candidate) => candidate.id),
    };
  }
  const watchId = uuid(deps);
  const watch = {
    id: watchId,
    account,
    kind: resolved.kind,
    inputUrl,
    canonicalId: resolved.canonicalId,
    ...(resolved.kind === 'youtube-channel' ? { uploadsPlaylistId: resolved.uploadsPlaylistId || null } : {}),
    title: resolved.title || resolved.channelTitle || null,
    notebookId,
    ...policy,
    enabled: true,
    cursorVideoId: null,
    createdAt: iso(nowMs(deps)),
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  const discovery = await youtubeApi(deps).discoverWatch(watch, {
    ...youtubeOptions(deps),
    maxPages: 1,
    untilVideoId: null,
  });
  const currentAt = nowMs(deps);
  const initial = initialItems > 0
    ? [...(discovery.items || [])].sort(comparePublished).slice(-initialItems)
    : [];
  // The YouTube adapter returns newest-first; the manifest is intentionally
  // written oldest-first so subsequent additions preserve playlist chronology.
  let savedWatch = watch;
  let racedExisting = false;
  await update(account, deps, (state) => {
    const duplicate = findMatchingWatch(state, resolved, notebookId);
    if (duplicate) {
      savedWatch = duplicate;
      racedExisting = true;
      return;
    }
    watch.cursorVideoId = discovery.newestVideoId || null;
    state.watches[watch.id] = watch;
    for (const item of initial) {
      if (!item?.videoId) continue;
      const candidate = {
        id: uuid(deps),
        watchId,
        sourceKey: sourceKey(item.videoId),
        videoId: item.videoId,
        url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
        title: item.title || null,
        channelId: item.channelId || null,
        channelTitle: item.channelTitle || null,
        publishedAt: item.publishedAt || null,
        discoveredAt: iso(currentAt),
        status: candidateStatusFor(policy.mode),
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        addedAt: null,
      };
      state.candidates[candidate.id] = candidate;
    }
  });
  return {
    watch: publicWatch(savedWatch),
    existing: racedExisting,
    initialCandidateCount: racedExisting ? 0 : initial.length,
    initialCandidateIds: Object.values((await read(account, deps)).candidates)
      .filter((candidate) => candidate.watchId === savedWatch.id)
      .map((candidate) => candidate.id),
  };
}

export async function listWatches(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const account = accountOf(input, deps);
  const state = await read(account, deps);
  const watches = Object.values(state.watches)
    .filter((watch) => input.watchId === undefined || watch.id === input.watchId)
    .filter((watch) => input.enabled === undefined || watch.enabled === input.enabled)
    .map(publicWatch);
  return { account, watches };
}

export async function listCandidates(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const account = accountOf(input, deps);
  const state = await read(account, deps);
  let statuses = input.status;
  if (statuses !== undefined && !Array.isArray(statuses)) statuses = [statuses];
  if (statuses) statuses.forEach(assertCandidateStatus);
  const candidates = Object.values(state.candidates)
    .filter((candidate) => input.watchId === undefined || candidate.watchId === input.watchId)
    .filter((candidate) => !statuses || statuses.includes(candidate.status))
    .sort(comparePublished)
    .map(publicCandidate);
  return { account, candidates };
}

export async function syncWatches(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const account = accountOf(input, deps);
  const atMs = nowMs(deps);
  const summary = emptySyncSummary(account, atMs);
  await update(account, deps, (state) => expireClaimsInState(state, atMs));
  const state = await read(account, deps);
  const watches = selectedWatches(state, input, atMs);
  for (const watch of watches) {
    try {
      const result = await syncOne(account, watch, input, deps);
      summary.watches.push(result);
      summary.discovered += result.discovered;
      summary.added += result.added;
      summary.retries += result.retries;
      summary.ageGated += result.ageGated;
      summary.capacityStops.push(...result.capacityStops);
      summary.addedCandidateIds.push(...result.addedCandidateIds);
      if (result.error) summary.watchErrors.push({ watchId: watch.id, error: result.error });
    } catch (error) {
      const message = errorText(error);
      summary.watches.push({ watchId: watch.id, discovered: 0, added: 0, error: message });
      summary.watchErrors.push({ watchId: watch.id, error: message });
      await markWatchFailure(account, watch.id, deps, nowMs(deps), error).catch(() => {});
    }
  }
  return summary;
}

function assertCandidateIds(input) {
  const ids = input.candidateIds;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new TypeError('candidateIds must be a non-empty array of strings');
  }
  return ids;
}

export async function approveCandidates(input, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  if (input.confirm !== true) throw new Error('confirm:true is required to approve candidates');
  const account = accountOf(input, deps);
  const ids = assertCandidateIds(input);
  const summary = {
    account,
    approved: [],
    retries: [],
    capacityStops: [],
    skipped: [],
    errors: [],
  };
  for (const id of ids) {
    const state = await read(account, deps);
    const candidate = state.candidates[id];
    if (!candidate) {
      summary.errors.push({ candidateId: id, error: 'candidate not found' });
      continue;
    }
    const watch = state.watches[candidate.watchId];
    if (!watch) {
      summary.errors.push({ candidateId: id, error: 'watch not found' });
      continue;
    }
    if (candidate.status === 'added') {
      summary.skipped.push({ candidateId: id, reason: 'already added' });
      continue;
    }
    const atMs = nowMs(deps);
    const claimed = await claimCandidate(account, id, deps, atMs, {
      ignoreAge: true,
      // claimCandidate first expires stale `adding` claims. Explicit approval
      // must allow that freshly-uncertain state to proceed to reconciliation.
      allowUncertain: true,
    });
    if (!claimed) {
      summary.skipped.push({ candidateId: id, reason: 'candidate is already being processed' });
      continue;
    }
    const operation = { added: 0, retries: 0, capacityStop: false, capacityStops: [], addedCandidateIds: [], candidateErrors: [] };
    await addClaimedCandidate(account, claimed, deps, atMs, operation);
    if (operation.added) summary.approved.push(id);
    else if (operation.capacityStop) summary.capacityStops.push(id);
    else if (operation.retries) summary.retries.push(id);
    summary.errors.push(...operation.candidateErrors);
  }
  return summary;
}

export async function manageWatches(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const action = input.action ?? input.operation ?? 'list';
  if (!MANAGE_ACTIONS.has(action)) throw new TypeError('action must be list, pause, resume, update, or remove');
  if (action === 'list') return listWatches(input, deps);
  const account = accountOf(input, deps);
  const watchId = stringRequired(input.watchId, 'watchId');
  if (action === 'remove' && input.confirm !== true) {
    throw new Error('confirm:true is required to remove a watch');
  }
  if (action === 'update') {
    const allowed = new Set(['mode', 'intervalHours', 'sourceLimit', 'reserveSlots', 'minAutoAddAgeHours', 'notebookId']);
    for (const key of Object.keys(input)) {
      if (!['action', 'operation', 'account', 'watchId'].includes(key) && !allowed.has(key)) {
        throw new TypeError(`cannot update field: ${key}`);
      }
    }
  }
  let result;
  await update(account, deps, (state) => {
    const watch = state.watches[watchId];
    if (!watch) throw new Error(`watch not found: ${watchId}`);
    if (action === 'pause') watch.enabled = false;
    if (action === 'resume') watch.enabled = true;
    if (action === 'update') {
      const policy = policyFrom(input, watch);
      Object.assign(watch, policy);
      if (input.notebookId !== undefined) watch.notebookId = stringRequired(input.notebookId, 'notebookId');
    }
    if (action === 'remove') {
      delete state.watches[watchId];
      let removedCandidates = 0;
      for (const [candidateId, candidate] of Object.entries(state.candidates)) {
        if (candidate.watchId === watchId) {
          delete state.candidates[candidateId];
          removedCandidates++;
        }
      }
      result = { removed: true, watchId, removedCandidates };
      return;
    }
    result = { action, watch: publicWatch(watch) };
  });
  return result;
}

export async function startupCatchUp(input = {}, deps = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const account = accountOf(input, deps);
  const checkedAtMs = nowMs(deps);
  await update(account, deps, (state) => {
    state.lastStartupCheckAt = iso(checkedAtMs);
  });
  const summary = await syncWatches({ ...input, account, force: false }, deps);
  return { account, lastStartupCheckAt: iso(checkedAtMs), ...summary };
}
