import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { INSTRUCTIONS, TOOLS, VERSION, isMainModule, setupReport } from '../src/index.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function deps(overrides = {}) {
  return {
    platform: 'win32',
    chromeInstalled: () => true,
    hasApiKey: () => false,
    listWatches: async () => ({ watches: [] }),
    checkSignIn: async () => true,
    ...overrides,
  };
}

test('server version and instructions come from one place', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(INSTRUCTIONS, /nlm_setup/);
  assert.match(INSTRUCTIONS, /nlm_auth/);
  assert.ok(TOOLS.some((tool) => tool.name === 'nlm_setup'));
});

test('setup reports ready without a YouTube key and suggests a first request', async () => {
  const report = await setupReport({}, deps());
  assert.equal(report.ready, true);
  assert.equal(report.checks.chrome, 'installed');
  assert.equal(report.checks.googleSignIn, 'signed-in');
  assert.match(report.checks.youtubeApiKey, /^not set \(optional/);
  assert.equal(report.nextSteps.length, 1);
  assert.match(report.nextSteps[0], /Everything is ready/);
});

test('setup lists missing Chrome and a signed-out profile as plain next steps', async () => {
  let signInChecked = false;
  const missingChrome = await setupReport(
    {},
    deps({ chromeInstalled: () => false, checkSignIn: async () => { signInChecked = true; return true; } }),
  );
  assert.equal(missingChrome.ready, false);
  assert.equal(missingChrome.checks.chrome, 'missing');
  assert.equal(signInChecked, false, 'no browser launch without Chrome');
  assert.match(missingChrome.nextSteps[0], /google\.com\/chrome/);

  const signedOut = await setupReport({}, deps({ checkSignIn: async () => false }));
  assert.equal(signedOut.ready, false);
  assert.equal(signedOut.checks.googleSignIn, 'signed-out');
  assert.match(signedOut.nextSteps[0], /nlm_auth/);
});

test('setup can skip the sign-in check and reports sign-in errors without throwing', async () => {
  const skipped = await setupReport({ checkSignIn: false }, deps({ checkSignIn: async () => { throw new Error('should not run'); } }));
  assert.equal(skipped.checks.googleSignIn, 'not-checked');

  const failed = await setupReport({}, deps({ checkSignIn: async () => { throw new Error(`boom at ${os.homedir()}/x`); } }));
  assert.equal(failed.checks.googleSignIn, 'error');
  assert.equal(failed.ready, false);
  assert.ok(!failed.nextSteps.join(' ').includes(os.homedir()));
});

test('isMainModule follows the symlinks npx and global installs use', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlm-main-'));
  const target = path.join(dir, 'index.js');
  fs.writeFileSync(target, '');
  const link = path.join(dir, 'notebooklm-curator');
  fs.symlinkSync(target, link);
  try {
    assert.equal(isMainModule(link, pathToFileURL(target).href), true);
    assert.equal(isMainModule(path.join(dir, 'other.js'), pathToFileURL(target).href), false);
    assert.equal(isMainModule(undefined, pathToFileURL(target).href), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Claude Desktop manifest matches package.json and lists every tool', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.server.entry_point, 'src/index.js');
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name).sort(),
    TOOLS.map((tool) => tool.name).sort(),
  );
  assert.equal(manifest.user_config.youtube_api_key.required, false);
});
