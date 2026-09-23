// @ts-check
/**
 * English and Russian carry the same keys.
 *
 * A key added to one language and forgotten in the other is a defect in this
 * project's terms: `t()` falls back to the key itself, so the reader gets
 * `views.rotate` where a sentence should be. Counting is cheap and catches it
 * the moment it happens.
 *
 * Red without the fix: add a key to `en` and not to `ru` (or the other way
 * round) and this reports the name of the key that is missing.
 */

import { LANGUAGES, STRINGS } from '../../src/i18n.js';

export function run() {
  const counts = LANGUAGES.map((l) => Object.keys(STRINGS[l] ?? {}).length);
  /** @type {string[]} */
  const missing = [];
  // Every key of every language has to exist in every other one. Equal counts
  // alone would pass a pair that is short one key each way.
  for (const a of LANGUAGES) {
    for (const b of LANGUAGES) {
      if (a === b) continue;
      for (const key of Object.keys(STRINGS[a] ?? {})) {
        if (!(key in (STRINGS[b] ?? {}))) missing.push(key + ' missing from ' + b);
      }
    }
  }
  const ok = missing.length === 0 && new Set(counts).size === 1;
  return {
    ok,
    detail: ok
      ? LANGUAGES.map((l, i) => l + ' ' + counts[i]).join(' = ')
      : LANGUAGES.map((l, i) => l + ' ' + counts[i]).join(' vs ') + '; ' + missing.slice(0, 5).join(', '),
  };
}
