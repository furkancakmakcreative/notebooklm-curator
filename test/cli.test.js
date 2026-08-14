import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { parseArgs, runCli } from '../src/cli.js';

function stream() {
  let value = '';
  return { write(chunk) { value += chunk; }, get value() { return value; } };
}

test('parses sync options and rejects invalid arguments', () => {
  assert.deepEqual(parseArgs(['sync', '--account', 'work', '--watch-id=w1', '--force', '--max-pages=3']), {
    account: 'work', watchId: 'w1', force: true, maxPages: 3,
  });
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  assert.throws(() => parseArgs(['--max-pages', '0']), /positive integer/);
  assert.throws(
    () => parseArgs(['--max-pages', '2', '--max-pages=3']),
    /may be specified only once/,
  );
});

test('prints successful sync output and closes the browser', async () => {
  const out = stream();
  const err = stream();
  let closed = false;
  let calls = 0;
  const code = await runCli(['sync', '--force'], {
    stdout: out,
    stderr: err,
    syncWatches: async (input) => { calls++; assert.deepEqual(input, { force: true }); return { ok: true }; },
    closeBrowser: async () => { closed = true; },
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.equal(out.value, '{"ok":true}\n');
  assert.equal(err.value, '');
  assert.equal(closed, true);
});

test('watch errors in the result still exit successfully', async () => {
  const out = stream();
  let closed = false;
  const code = await runCli([], {
    stdout: out,
    syncWatches: async () => ({ watchErrors: [{ watchId: 'w1', error: 'failed' }] }),
    closeBrowser: async () => { closed = true; },
  });
  assert.equal(code, 0);
  assert.match(out.value, /watchErrors/);
  assert.equal(closed, true);
});

test('top-level errors print sanitized JSON, exit 1, and close the browser', async () => {
  const out = stream();
  const err = stream();
  let closed = false;
  const code = await runCli(['--account', 'x'], {
    stdout: out,
    stderr: err,
    syncWatches: async () => { throw new Error('state failed?key=secret'); },
    closeBrowser: async () => { closed = true; },
  });
  assert.equal(code, 1);
  assert.equal(out.value, '');
  assert.equal(err.value, '{"error":"state failed?key=REDACTED"}\n');
  assert.equal(closed, true);
});

test('importing cli.js with no argv[1] does not execute the CLI', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "process.argv[1] = undefined; await import('./src/cli.js'); process.stdout.write('imported')",
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
