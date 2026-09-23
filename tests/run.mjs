// The product's test bench.
//
//   node tests/run.mjs            every check except the long ones
//   node tests/run.mjs <group>/   one group, long ones included
//   node tests/run.mjs <name>     one check, by "group/name" or by its bare name
//
// Exit codes: 0 green, 1 at least one failure, 2 nothing matched the argument.
//
// A check is a module under tests/<group>/<name>.mjs exporting `run()`, which
// returns (or resolves to) `{ok, detail}`. `detail` is one line carrying the
// number the check measured, because a number is what tells a near miss from a
// collapse next time someone reads the log.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Files in tests/ that are shared code rather than checks. */
const NOT_A_CHECK = new Set(['run.mjs', 'fixtures.mjs']);

/**
 * Groups left out when no argument is given.
 *
 * `perf` carves three grids up to 512 and takes around half a minute - long
 * enough that people would stop running the bench at all. It is asked for by
 * name: `node tests/run.mjs perf/`.
 */
const LONG = new Set(['perf']);

/** @returns {Promise<Array<{group: string, name: string, file: string}>>} */
async function discover() {
  const out = [];
  for (const entry of await readdir(here, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(here, entry.name);
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.mjs') || NOT_A_CHECK.has(f)) continue;
      out.push({ group: entry.name, name: f.slice(0, -4), file: join(dir, f) });
    }
  }
  out.sort((a, b) => (a.group + '/' + a.name).localeCompare(b.group + '/' + b.name));
  return out;
}

/**
 * @param {Array<{group: string, name: string, file: string}>} all
 * @param {string|undefined} arg
 */
function select(all, arg) {
  if (!arg) return all.filter((t) => !LONG.has(t.group));
  const q = arg.replace(/\\/g, '/');
  if (q.endsWith('/')) {
    const g = q.slice(0, -1);
    return all.filter((t) => t.group === g);
  }
  if (q.includes('/')) return all.filter((t) => t.group + '/' + t.name === q);
  // A bare word may be either a check's own name or a whole group.
  const byName = all.filter((t) => t.name === q);
  return byName.length > 0 ? byName : all.filter((t) => t.group === q);
}

const arg = process.argv[2];
const all = await discover();
const chosen = select(all, arg);

if (chosen.length === 0) {
  console.error('No check matches "' + arg + '".');
  console.error('Known checks: ' + all.map((t) => t.group + '/' + t.name).join(', '));
  process.exit(2);
}

let green = 0;
let failed = 0;

for (const t of chosen) {
  const id = t.group + '/' + t.name;
  let ok = false;
  let detail = '';
  try {
    const mod = await import(pathToFileURL(t.file).href);
    if (typeof mod.run !== 'function') throw new Error('no run() export');
    const res = await mod.run();
    ok = !!res?.ok;
    detail = String(res?.detail ?? '');
  } catch (err) {
    // A check that throws is a failure, not a crash of the bench: the rest
    // still have to report, or one broken import hides every other answer.
    ok = false;
    detail = 'threw: ' + (err instanceof Error ? err.message : String(err));
  }
  if (ok) {
    green++;
    console.log('ok   ' + id.padEnd(22) + detail);
  } else {
    failed++;
    console.error('FAIL ' + id.padEnd(22) + detail);
  }
}

const skipped = all.filter((t) => !chosen.includes(t));
if (!arg && skipped.length > 0) {
  console.log('     ' + skipped.length + ' long check(s) not run: '
    + [...new Set(skipped.map((t) => t.group + '/'))].join(' ') + ' - ask for them by name');
}

console.log('\n' + green + ' green / ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
