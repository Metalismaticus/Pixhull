// Syntax check for every module.
//
// `node --check` is not enough: it accepted a string literal broken across two
// lines that the browser rejected outright, and the app shipped dead. Actually
// importing each module is the real test, so that is what this does.
//
// Modules that touch the DOM will fail at evaluation under Node - that is
// expected and not a syntax problem, so those errors are filtered out. Anything
// else fails the run.

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** Errors that mean "this module needs a browser", not "this module is broken". */
const BROWSER_ONLY = /\b(document|window|navigator|localStorage|createImageBitmap|btoa|atob)\b.*is not defined/;

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

// Entry points are excluded: importing them runs them. The server would sit
// waiting on stdin and the smoke test would launch a second server; both are
// covered by tools/mcp-smoke.mjs instead.
const ENTRY_POINTS = ['check.mjs', 'serve.mjs', 'mcp-smoke.mjs', 'server.js'];

const files = [
  ...(await walk(join(root, 'src'))),
  ...(await walk(join(root, 'tools'))),
  ...(await walk(join(root, 'mcp'))),
].filter((f) => !ENTRY_POINTS.some((e) => f.endsWith(e)));

let failed = 0;
for (const file of files) {
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  try {
    await import(pathToFileURL(file).href);
    console.log('ok   ' + rel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (BROWSER_ONLY.test(message)) {
      console.log('ok   ' + rel + '  (parses; needs a browser to run)');
      continue;
    }
    console.error('FAIL ' + rel + '\n     ' + message);
    failed++;
  }
}

if (failed > 0) {
  console.error('\n' + failed + ' module(s) failed.');
  process.exit(1);
}
console.log('\nAll ' + files.length + ' modules parse.');
