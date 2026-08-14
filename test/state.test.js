import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_VERSION,
  emptyState,
  normalizeAccount,
  readState,
  statePath,
  updateState,
} from '../src/state.js';

async function tempBaseDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nlm-state-test-'));
}

test('empty initialization is side-effect free', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });

  assert.deepEqual(await readState('default', { baseDir }), emptyState());
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('normalizes valid accounts and rejects unsafe slugs', () => {
  assert.equal(normalizeAccount(), 'default');
  assert.equal(normalizeAccount('work_2-east'), 'work_2-east');
  for (const account of ['', 'a/b', '..', 'a.b', 'a b', 42, null]) {
    assert.throws(() => normalizeAccount(account));
  }
});

test('updates round-trip through the versioned state file', async () => {
  const baseDir = await tempBaseDir();
  const { state, result } = await updateState(
    'default',
    (current) => {
      current.watches.example = { enabled: true };
      current.lastStartupCheckAt = '2026-08-14T00:00:00.000Z';
      return 'saved';
    },
    { baseDir, now: () => 1000 },
  );

  assert.equal(result, 'saved');
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(await readState('default', { baseDir }), state);
});

test('serializes concurrent in-process updates without lost writes', async () => {
  const baseDir = await tempBaseDir();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      updateState('default', async (current) => {
        await Promise.resolve();
        current.watches[`watch-${index}`] = { index };
        return index;
      }, { baseDir, retryDelayMs: 0 }),
    ),
  );

  const state = await readState('default', { baseDir });
  assert.equal(Object.keys(state.watches).length, 20);
  assert.deepEqual(state.watches['watch-19'], { index: 19 });
});

test('rejects malformed JSON and unsupported state versions', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  await fs.writeFile(filePath, '{not json', 'utf8');
  await assert.rejects(readState('default', { baseDir }), /malformed state JSON/);

  await fs.writeFile(filePath, JSON.stringify({ ...emptyState(), version: 2 }), 'utf8');
  await assert.rejects(readState('default', { baseDir }), /unsupported state version/);
});

test('times out on a live lock', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ createdAt: 100 }), 'utf8');

  await assert.rejects(
    updateState('default', () => {}, {
      baseDir,
      now: () => 100,
      lockTimeoutMs: 10,
      staleLockMs: 1000,
      retryDelayMs: 1,
    }),
    (error) => error.code === 'ELOCKTIMEOUT' && !error.message.includes(filePath),
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), JSON.stringify({ createdAt: 100 }));
});

test('recovers stale locks', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ owner: 'dead', pid: 123, createdAt: 0 }), 'utf8');

  const { result } = await updateState('default', (current) => {
    current.watches.recovered = true;
    return 'recovered';
  }, {
    baseDir,
    now: () => 1000,
    staleLockMs: 100,
    retryDelayMs: 0,
    isProcessAlive: () => false,
  });

  assert.equal(result, 'recovered');
  assert.equal((await readState('default', { baseDir })).watches.recovered, true);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('old owners cannot release a replacement lock', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });
  const lockPath = `${filePath}.lock`;
  const tombstonePath = `${lockPath}.test-tombstone`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  await updateState('default', async (current) => {
    await fs.rename(lockPath, tombstonePath);
    await fs.writeFile(lockPath, JSON.stringify({ owner: 'replacement', createdAt: 1000 }), 'utf8');
    await fs.unlink(tombstonePath);
    current.watches.replacement = true;
  }, { baseDir, now: () => 1000 });

  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).owner, 'replacement');
  await fs.unlink(lockPath);
});

test('never steals an old lock while its owner process is alive', async () => {
  const baseDir = await tempBaseDir();
  const filePath = statePath('default', { baseDir });
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ owner: 'live', pid: 123, createdAt: 0, heartbeatAt: 0 }),
    'utf8',
  );

  await assert.rejects(
    updateState('default', () => {}, {
      baseDir,
      now: () => 1000,
      lockTimeoutMs: 10,
      staleLockMs: 100,
      retryDelayMs: 1,
      isProcessAlive: () => true,
    }),
    (error) => error.code === 'ELOCKTIMEOUT',
  );
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).owner, 'live');
});

test('updater failure preserves the prior state and cleans the lock', async () => {
  const baseDir = await tempBaseDir();
  await updateState('default', (current) => {
    current.watches.keep = { value: 1 };
  }, { baseDir });
  const before = await readState('default', { baseDir });

  await assert.rejects(
    updateState('default', (current) => {
      current.watches.keep.value = 2;
      throw new Error('updater failed');
    }, { baseDir }),
    /updater failed/,
  );

  assert.deepEqual(await readState('default', { baseDir }), before);
  await assert.rejects(fs.stat(`${statePath('default', { baseDir })}.lock`), { code: 'ENOENT' });
});
