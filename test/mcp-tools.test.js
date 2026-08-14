import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createToolHandler, TOOLS, sanitizeError, startServer, validateArgs } from '../src/index.js';

const tool = (name) => {
  const found = TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `missing tool: ${name}`);
  return found;
};

test('exposes all watch tools and preserves the existing tools', () => {
  assert.equal(typeof sanitizeError, 'function');
  assert.equal(typeof startServer, 'function');
  const names = new Set(TOOLS.map(({ name }) => name));
  for (const name of [
    'nlm_watch_source',
    'nlm_manage_watches',
    'nlm_sync_watches',
    'nlm_list_candidates',
    'nlm_approve_candidates',
  ]) {
    assert.ok(names.has(name));
  }
  for (const name of [
    'nlm_auth',
    'nlm_list_notebooks',
    'nlm_list_sources',
    'nlm_remove_source',
    'nlm_create_notebook',
    'nlm_rename_notebook',
    'nlm_add_source',
    'nlm_ask',
    'nlm_audit',
  ]) {
    assert.ok(names.has(name));
  }

  assert.deepEqual(tool('nlm_manage_watches').inputSchema.properties.action.enum, [
    'list',
    'pause',
    'resume',
    'update',
    'remove',
  ]);
  assert.deepEqual(tool('nlm_watch_source').inputSchema.properties.mode.enum, [
    'report',
    'review',
    'auto',
  ]);
  assert.deepEqual(tool('nlm_list_candidates').inputSchema.properties.status.items.enum, [
    'reported',
    'pending',
    'retry',
    'added',
    'ignored',
    'uncertain',
  ]);
  assert.equal('ids' in tool('nlm_approve_candidates').inputSchema.properties, false);
});

test('validates enums, arrays, integer fields, and numeric bounds', () => {
  const manage = tool('nlm_manage_watches');
  assert.doesNotThrow(() => validateArgs(manage, { action: 'pause', watchId: 'watch-1' }));
  assert.throws(
    () => validateArgs(manage, { action: 'unknown' }),
    /must be one of/,
  );

  const candidates = tool('nlm_list_candidates');
  assert.doesNotThrow(() =>
    validateArgs(candidates, { status: ['pending', 'retry'] }),
  );
  assert.throws(() => validateArgs(candidates, { status: 'pending' }), /must be an array/);
  assert.throws(
    () => validateArgs(candidates, { status: ['not-a-status'] }),
    /must be one of/,
  );

  const sync = tool('nlm_sync_watches');
  assert.doesNotThrow(() => validateArgs(sync, { maxPages: 2 }));
  assert.throws(() => validateArgs(sync, { maxPages: 1.5 }), /must be an integer/);
  assert.throws(() => validateArgs(sync, { maxPages: 0 }), /at least 1/);

  const audit = tool('nlm_audit');
  assert.doesNotThrow(() => validateArgs(audit, { notebookId: 'notebook', searchBudget: 0 }));
  assert.throws(
    () => validateArgs(audit, { notebookId: 'notebook', searchBudget: 1.5 }),
    /must be an integer/,
  );
  assert.throws(
    () => validateArgs(audit, { notebookId: 'notebook', searchBudget: -1 }),
    /at least 0/,
  );

  const watch = tool('nlm_watch_source');
  assert.doesNotThrow(() =>
    validateArgs(watch, { source: '@creator', notebookId: 'notebook', initialItems: 50 }),
  );
  assert.throws(() => validateArgs(watch, { notebookId: 'notebook' }), /missing required argument: source/);
  assert.throws(
    () => validateArgs(watch, { source: '@creator', notebookId: 'notebook', initialItems: 51 }),
    /at most 50/,
  );
  assert.throws(
    () => validateArgs(watch, { source: '@creator', notebookId: 'notebook', reserveSlots: -1 }),
    /at least 0/,
  );

  const approve = tool('nlm_approve_candidates');
  assert.doesNotThrow(() =>
    validateArgs(approve, { candidateIds: ['candidate-1'], confirm: true }),
  );
  assert.throws(
    () => validateArgs(approve, { candidateIds: ['candidate-1', 2], confirm: true }),
    /must be a string/,
  );
  assert.throws(
    () => validateArgs(approve, { candidateIds: [], confirm: true }),
    /at least 1 item/,
  );
  assert.throws(
    () => validateArgs(approve, { ids: ['candidate-1'], confirm: true }),
    /missing required argument: candidateIds/,
  );
});

test('sanitizes watch error fields at the MCP response boundary only', async () => {
  const previousDataDir = process.env.NLM_DATA_DIR;
  const customPath = 'C:\\private\\notebooklm-data';
  process.env.NLM_DATA_DIR = customPath;
  try {
    const handler = createToolHandler({
      watchDeps: {
        state: {
          async readState() {
            return {
              version: 1,
              watches: {
                watch1: {
                  id: 'watch1',
                  lastError: `failed to read ${customPath}\\accounts\\default\\watch-state.json`,
                  title: customPath,
                  inputUrl: 'https://www.youtube.com/@creator',
                  enabled: true,
                },
              },
              candidates: {},
              lastStartupCheckAt: null,
            };
          },
          async updateState() {},
        },
      },
    });
    const response = await handler({
      params: { name: 'nlm_manage_watches', arguments: { action: 'list' } },
    });
    const body = JSON.parse(response.content[0].text);
    const watch = body.watches[0];
    assert.equal(watch.inputUrl, 'https://www.youtube.com/@creator');
    assert.equal(watch.title, customPath);
    assert.doesNotMatch(watch.lastError, new RegExp(customPath.replaceAll('\\', '\\\\')));
    assert.match(watch.lastError, /failed to read ~/);
  } finally {
    if (previousDataDir === undefined) delete process.env.NLM_DATA_DIR;
    else process.env.NLM_DATA_DIR = previousDataDir;
  }
});

test('importing index.js does not connect MCP stdio', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./src/index.js'); process.stdout.write('imported')",
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'imported');
  assert.equal(result.stderr, '');
});
