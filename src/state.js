import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const STATE_VERSION = 1;

const STATE_FILE_NAME = 'watch-state.json';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const updateQueues = new Map();

function defaultBaseDir() {
  return (
    process.env.NLM_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'notebooklm-curator')
      : path.join(os.homedir(), '.local', 'share', 'notebooklm-curator'))
  );
}

export function normalizeAccount(account = 'default') {
  if (typeof account !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(account)) {
    throw new Error(
      `invalid account name "${account}": only letters, digits, "-" and "_" are allowed`,
    );
  }
  return account;
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    watches: {},
    candidates: {},
    lastStartupCheckAt: null,
  };
}

export function statePath(account = 'default', options = {}) {
  const normalizedAccount = normalizeAccount(account);
  const baseDir = options.baseDir ?? defaultBaseDir();
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new TypeError('options.baseDir must be a non-empty string');
  }
  return path.join(baseDir, 'accounts', normalizedAccount, STATE_FILE_NAME);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateState(state) {
  if (!isRecord(state)) throw new Error('state must be a JSON object');

  const keys = Object.keys(state).sort();
  const expectedKeys = ['candidates', 'lastStartupCheckAt', 'version', 'watches'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('state has an unsupported schema');
  }
  if (state.version !== STATE_VERSION) {
    throw new Error(`unsupported state version: ${state.version}`);
  }
  if (!isRecord(state.watches) || !isRecord(state.candidates)) {
    throw new Error('state watches and candidates must be objects');
  }
  if (state.lastStartupCheckAt !== null && typeof state.lastStartupCheckAt !== 'string') {
    throw new Error('state lastStartupCheckAt must be a string or null');
  }
  return state;
}

async function readStateFile(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`malformed state JSON: ${error.message}`, { cause: error });
    }
    return validateState(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function readState(account = 'default', options = {}) {
  return readStateFile(statePath(account, options));
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (value === undefined) return Date.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('options.now must return a finite timestamp');
  }
  return value;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function lockAgeMs(lockPath, currentTime) {
  try {
    const [contents, stats] = await Promise.all([
      fs.readFile(lockPath, 'utf8').catch(() => null),
      fs.stat(lockPath),
    ]);
    if (contents !== null) {
      try {
        const lock = JSON.parse(contents);
        const heartbeatAt = lock.heartbeatAt ?? lock.createdAt;
        if (typeof heartbeatAt === 'number' && Number.isFinite(heartbeatAt)) {
          return currentTime - heartbeatAt;
        }
      } catch {
        // Fall back to the filesystem timestamp for locks from another process.
      }
    }
    return currentTime - stats.mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readLockRecord(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {};
  }
}

function processIsAlive(pid, options) {
  if (typeof options.isProcessAlive === 'function') return options.isProcessAlive(pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function writeLockRecord(handle, record) {
  await handle.truncate(0);
  await handle.write(JSON.stringify(record), 0, 'utf8');
  await handle.sync();
}

function startLockHeartbeat(handle, record, options, staleLockMs) {
  if (staleLockMs <= 0) return () => {};
  const intervalMs = Math.max(1, Math.min(1000, Math.floor(staleLockMs / 3)));
  let stopped = false;
  let pending = null;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = (async () => {
      record.heartbeatAt = nowMs(options.now);
      await writeLockRecord(handle, record);
    })()
      .catch(() => {
        // The lock may have been renamed by stale recovery. The owner still
        // holds its descriptor, and release will verify the pathname token.
      })
      .finally(() => {
        pending = null;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function acquireLock(lockPath, options) {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new TypeError('options.lockTimeoutMs must be a non-negative number');
  }
  if (!Number.isFinite(staleLockMs) || staleLockMs < 0) {
    throw new TypeError('options.staleLockMs must be a non-negative number');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('options.retryDelayMs must be a non-negative number');
  }

  const startedAt = Date.now();
  const owner = randomUUID();
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
      const createdAt = nowMs(options.now);
      const record = { owner, pid: process.pid, createdAt, heartbeatAt: createdAt };
      await writeLockRecord(handle, record);
      return {
        owner,
        handle,
        stopHeartbeat: startLockHeartbeat(handle, record, options, staleLockMs),
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') {
        throw error;
      }

      const age = await lockAgeMs(lockPath, nowMs(options.now));
      if (age !== null && age >= staleLockMs) {
        const existing = await readLockRecord(lockPath);
        // Age alone is never enough to steal a lock: the owner may merely be
        // paused. A dead PID cannot resume and later remove its replacement,
        // which makes this stale takeover safe.
        if (!existing?.pid || processIsAlive(existing.pid, options)) {
          if (Date.now() - startedAt >= lockTimeoutMs) {
            const timeoutError = new Error('timed out acquiring state lock');
            timeoutError.code = 'ELOCKTIMEOUT';
            throw timeoutError;
          }
          await sleep(retryDelayMs);
          continue;
        }
        const tombstonePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await fs.rename(lockPath, tombstonePath);
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
          continue;
        }
        await fs.unlink(tombstonePath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        const timeoutError = new Error('timed out acquiring state lock');
        timeoutError.code = 'ELOCKTIMEOUT';
        throw timeoutError;
      }
      await sleep(retryDelayMs);
    }
  }
}

async function releaseLock(lockPath, lock) {
  lock.stopHeartbeat();
  try {
    let ownsPath = false;
    try {
      const record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      ownsPath = record?.owner === lock.owner;
    } catch (error) {
      if (error.code !== 'ENOENT') return;
    }
    if (ownsPath) await fs.unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  } finally {
    await lock.handle.close().catch(() => {});
  }
}

async function writeState(filePath, state) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function runSerialized(key, operation) {
  const previous = updateQueues.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  updateQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (updateQueues.get(key) === current) updateQueues.delete(key);
  }
}

export function updateState(account = 'default', updater, options = {}) {
  if (typeof updater !== 'function') throw new TypeError('updater must be a function');
  const filePath = statePath(account, options);
  const lockPath = `${filePath}.lock`;

  return runSerialized(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await acquireLock(lockPath, options);
      const currentState = await readStateFile(filePath);
      const result = await updater(currentState);
      validateState(currentState);
      await writeState(filePath, currentState);
      return { state: currentState, result };
    } finally {
      if (lock) await releaseLock(lockPath, lock);
    }
  });
}
