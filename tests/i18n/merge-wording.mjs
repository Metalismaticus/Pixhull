// @ts-check
/**
 * The merge offer says what it counts.
 *
 * The line under the merge button used to read "{n} slots hold a colour another
 * slot already has" (RU: "цвет, который уже есть в другом слоте"). That is not
 * what the number is. `mergeOffer()` calls `planMerge(MERGE_DELTA_E)`, so `n`
 * counts slots within ΔE 1 of a heavier one - colours nobody can tell apart,
 * not colours that are the same. Measured on the owner's sheet (2026-09-24,
 * grid 256): exactly 0 slots duplicate another byte for byte, while 124 are
 * within ΔE 1. Every one of those 124 was announced as a duplicate.
 *
 * This check builds the same situation in miniature and holds the wording to
 * it: a palette with zero exact duplicates and a non-zero offer. Then both
 * languages are read for two things - the offer line must not claim sameness,
 * and no merge-related string anywhere may call a near-duplicate a duplicate.
 * The second half is what keeps the lie from coming back in the button label,
 * which is where the Russian side had it ("Слить дубликаты").
 *
 * Red without the fix: restore either wording and the case names the key and
 * the phrase it was caught on.
 */

import { Palette, MERGE_DELTA_E } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { mergeOffer } from '../../src/edit/merge-offer.js';
import { LANGUAGES, STRINGS } from '../../src/i18n.js';

/**
 * Phrases that claim two entries carry the same colour. A near-duplicate is
 * not one, and the offer counts near-duplicates only.
 * @type {Record<string, string[]>}
 */
const CLAIMS_SAMENESS = {
  en: ['already has', 'the same colour', 'the same color', 'identical'],
  ru: ['уже есть', 'такой же', 'совпада', 'одинаков'],
};

/**
 * "duplicate" on its own is the same lie in one word, so it is only allowed
 * with the hedge in front of it.
 * @type {Record<string, {word: string, hedge: string}>}
 */
const HEDGED = {
  en: { word: 'duplicate', hedge: 'near-' },
  ru: { word: 'дубликат', hedge: 'почти-' },
};

/** Keys whose subject is the merge, and so are held to the wording above. */
const SUBJECT = /merge|NearDuplicate|paletteFull/i;

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;

  // 1. The situation the line describes: near-duplicates, no duplicates.
  const palette = new Palette();
  palette.add(0xff, 0x88, 0x44);
  palette.add(0xfe, 0x88, 0x45);
  palette.add(0x20, 0x60, 0xc0);
  const seen = new Set();
  let exactDupes = 0;
  for (const i of palette.slots()) {
    if (seen.has(palette.colors[i])) exactDupes++;
    else seen.add(palette.colors[i]);
  }
  const offer = mergeOffer({
    palette,
    volume: new Volume(8),
    building: false,
    deltaE: MERGE_DELTA_E,
  });
  cases++;
  if (exactDupes !== 0) bad.push('fixture has ' + exactDupes + ' exact duplicates, want 0');
  cases++;
  if (offer.noteKey !== 'edit.mergeReady') bad.push('offer note is ' + offer.noteKey + ', want edit.mergeReady');
  cases++;
  const offered = offer.noteParams?.n ?? 0;
  if (offered < 1) bad.push('offer freed ' + offered + ' slots, want at least 1');

  // 2. What that key says, in every language.
  for (const lang of LANGUAGES) {
    const line = (STRINGS[lang] ?? {})['edit.mergeReady'] ?? '';
    for (const phrase of CLAIMS_SAMENESS[lang] ?? []) {
      cases++;
      if (line.toLowerCase().includes(phrase)) {
        bad.push(lang + ' edit.mergeReady claims sameness: "' + phrase + '"');
      }
    }
  }

  // 3. And no merge string anywhere calls a near-duplicate a duplicate.
  for (const lang of LANGUAGES) {
    const hedged = HEDGED[lang];
    for (const [key, value] of Object.entries(STRINGS[lang] ?? {})) {
      if (!SUBJECT.test(key)) continue;
      const text = value.toLowerCase();
      for (const phrase of CLAIMS_SAMENESS[lang] ?? []) {
        cases++;
        if (text.includes(phrase)) bad.push(lang + ' ' + key + ' claims sameness: "' + phrase + '"');
      }
      if (!hedged) continue;
      let at = text.indexOf(hedged.word);
      while (at >= 0) {
        cases++;
        if (!text.slice(0, at).endsWith(hedged.hedge)) {
          bad.push(lang + ' ' + key + ' says "' + hedged.word + '" without "' + hedged.hedge + '"');
        }
        at = text.indexOf(hedged.word, at + 1);
      }
    }
  }

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; ' + exactDupes + ' exact duplicates but ' + offered
        + ' slots within ΔE ' + MERGE_DELTA_E + ', and the wording says so in '
        + LANGUAGES.length + ' languages'
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
