#!/usr/bin/env node

import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { syncWatches as defaultSyncWatches } from './watches.js';

function argumentError(message) {
  throw new TypeError(message);
}

function valueFor(argv, index, token, name) {
  const equals = token.indexOf('=');
  if (equals !== -1) {
    const value = token.slice(equals + 1);
    if (!value) argumentError(`${name} requires a value`);
    return { value, next: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) argumentError(`${name} requires a value`);
  return { value, next: index + 1 };
}

export function parseArgs(argv = []) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    argumentError('argv must be an array of strings');
  }
  const result = {};
  let sawSync = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === 'sync') {
      if (sawSync) argumentError('sync may be specified only once');
      sawSync = true;
      continue;
    }
    if (token === '--force') {
      if (result.force !== undefined) argumentError('--force may be specified only once');
      result.force = true;
      continue;
    }
    const option = token.match(/^(--account|--watch-id|--max-pages)(?:=|$)/)?.[1];
    if (!option) argumentError(`unknown argument: ${token}`);
    const { value, next } = valueFor(argv, index, token, option);
    const resultKey =
      option === '--watch-id' ? 'watchId' : option === '--max-pages' ? 'maxPages' : 'account';
    if (result[resultKey] !== undefined) {
      argumentError(`${option} may be specified only once`);
    }
    if (option === '--max-pages') {
      if (!/^\d+$/.test(value) || Number(value) < 1) argumentError('--max-pages must be a positive integer');
      result[resultKey] = Number(value);
    } else {
      if (!value.trim()) argumentError(`${option} must be non-empty`);
      result[resultKey] = value;
    }
    index = next;
  }
  return result;
}

function sanitizeError(error) {
  let message = String(error?.message || error)
    .replace(/([?&]key=)[^&\s]+/gi, '$1REDACTED');
  const home = os.homedir();
  if (home) message = message.split(home).join('~');
  return message.replace(/\s+/g, ' ').trim();
}

async function defaultCloseBrowser() {
  const browser = await import('./browser.js');
  return browser.closeBrowser();
}

export async function runCli(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const sync = deps.syncWatches ?? defaultSyncWatches;
  const closeBrowser = deps.closeBrowser ?? defaultCloseBrowser;
  try {
    const input = parseArgs(argv);
    const result = await sync(input, deps.syncDeps ?? deps);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ error: sanitizeError(error) })}\n`);
    return 1;
  } finally {
    await closeBrowser();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
