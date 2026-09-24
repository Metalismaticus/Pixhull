// @ts-check
/**
 * The merge button is dark exactly when the merge cannot happen, and says why.
 *
 * Measured on the code before the fix: a `Palette` holding #ff8844 and #fe8845
 * plans `freed 1`, and the button lit on that alone - before any model existed,
 * and while a build was running. `mergeColors()` meanwhile returned in silence
 * unless `state.volume` was there and `state.building` was false. That is the
 * wrong column of `docs/DESIGN.md` §7 ("Кнопка активна, по нажатию — ошибка")
 * and it breaks §6 ("выключенное всегда объясняется"). The second half of the
 * same place: the reason under a dark button belongs in `.hint.warn`, not a
 * plain `.hint` (`docs/DESIGN.md` §8).
 *
 * Two halves, because `src/main.js` needs a DOM and a WebGL2 context and cannot
 * be imported in Node (`docs/TESTING.md`, "Чего проверки не видят"):
 *
 *  1. the decision, measured against a real `Palette` and `Volume` through
 *     `mergeOffer()` - including the reviewer's exact pair of colours;
 *  2. the wiring, read from the source of `refreshMergeOffer()`: the button's
 *     `disabled` comes from the offer, and the note's `warn` class is toggled
 *     from it.
 *
 * How the cases go red:
 *  - `mergeOffer` deciding on `plan.freed.length` alone (the old rule): the
 *    "no model" and "building" cases report enabled=true and no reason;
 *  - `warn: true` dropped from the off-branches: the four `warn` cases flip;
 *  - the note class toggle removed from `refreshMergeOffer()`: "the note class
 *    is not toggled from the offer";
 *  - `btn.disabled` computed from anything but the offer: "the button is not
 *    disabled from the offer";
 *  - `refreshMergeOffer()` dropped from `applyRecolour()`: "applyRecolour() does
 *    not refresh the merge offer, so the plan goes stale".
 */

import { readFile } from 'node:fs/promises';
import { Palette, MERGE_DELTA_E } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { mergeOffer } from '../../src/edit/merge-offer.js';
import { LANGUAGES, STRINGS } from '../../src/i18n.js';

/** @type {string[]} */
const bad = [];
let cases = 0;

/** @param {string} name @param {*} got @param {*} want */
function eq(name, got, want) {
  cases++;
  if (got !== want) bad.push(name + '=' + String(got) + ' want ' + String(want));
}

/** The reviewer's palette: two colours nobody can tell apart, nothing else. */
function twinPalette() {
  const pal = new Palette();
  pal.add(0xff, 0x88, 0x44);
  pal.add(0xfe, 0x88, 0x45);
  return pal;
}

function checkDecision() {
  const pal = twinPalette();
  const vol = new Volume(8, 8, 8);

  // The measurement that started this: the plan does free a slot, so the old
  // rule would have lit the button here.
  eq('planFreed', pal.planMerge(MERGE_DELTA_E).freed.length, 1);

  const noModel = mergeOffer({ palette: pal, volume: null, building: false, deltaE: MERGE_DELTA_E });
  eq('noModel.enabled', noModel.enabled, false);
  eq('noModel.plan', noModel.plan, null);
  eq('noModel.note', noModel.noteKey, 'edit.mergeNoModel');
  eq('noModel.warn', noModel.warn, true);

  // Building, with a model already on screen: still off, and for the reason
  // that goes away by itself.
  const mid = mergeOffer({ palette: pal, volume: vol, building: true, deltaE: MERGE_DELTA_E });
  eq('building.enabled', mid.enabled, false);
  eq('building.plan', mid.plan, null);
  eq('building.note', mid.noteKey, 'edit.mergeBuilding');
  eq('building.warn', mid.warn, true);

  // Building before there is any model at all: one reason, not two.
  const both = mergeOffer({ palette: pal, volume: null, building: true, deltaE: MERGE_DELTA_E });
  eq('buildingNoModel.note', both.noteKey, 'edit.mergeBuilding');

  const ready = mergeOffer({ palette: pal, volume: vol, building: false, deltaE: MERGE_DELTA_E });
  eq('ready.enabled', ready.enabled, true);
  eq('ready.note', ready.noteKey, 'edit.mergeReady');
  eq('ready.n', ready.noteParams?.n, 1);
  // A working hint, not a reason for something being off.
  eq('ready.warn', ready.warn, false);
  eq('ready.freed', ready.plan?.freed.length, 1);

  // Nothing near-duplicate left: off, and the reason names the free slots the
  // last merge handed back.
  const done = new Palette();
  done.add(0xff, 0x88, 0x44);
  done.add(0x20, 0x90, 0xd0);
  const plan = done.planMerge(MERGE_DELTA_E);
  eq('cleanPlanFreed', plan.freed.length, 0);
  const clean = mergeOffer({ palette: done, volume: vol, building: false, deltaE: MERGE_DELTA_E });
  eq('clean.enabled', clean.enabled, false);
  eq('clean.note', clean.noteKey, 'edit.mergeNone');
  eq('clean.warn', clean.warn, true);

  // After a real merge the palette has a hole, so the reason changes to it.
  const merged = twinPalette();
  merged.add(0x20, 0x90, 0xd0);
  merged.applyMerge(merged.planMerge(MERGE_DELTA_E));
  eq('holes', merged.free.size, 1);
  const freed = mergeOffer({ palette: merged, volume: vol, building: false, deltaE: MERGE_DELTA_E });
  eq('freed.enabled', freed.enabled, false);
  eq('freed.note', freed.noteKey, 'edit.mergeFree');
  eq('freed.n', freed.noteParams?.n, 1);
  eq('freed.warn', freed.warn, true);

  // A recolour moves one colour in Lab, so the offer on screen is about the
  // colours the palette no longer holds. Measured: the twin pair offers one
  // freed slot; recolouring slot 2 to #0078ff leaves nothing near-duplicate at
  // all. Held as a plan, that stale offer repaints the freshly chosen colour
  // into its neighbour - which is why `applyRecolour()` has to ask again.
  const drifted = twinPalette();
  eq('drifted.before', mergeOffer({
    palette: drifted, volume: vol, building: false, deltaE: MERGE_DELTA_E,
  }).plan?.freed.length, 1);
  eq('drifted.replaced', drifted.replace(2, 0x00, 0x78, 0xff), true);
  const settled = mergeOffer({
    palette: drifted, volume: vol, building: false, deltaE: MERGE_DELTA_E,
  });
  eq('drifted.after.enabled', settled.enabled, false);
  eq('drifted.after.plan', settled.plan, null);
  eq('drifted.after.note', settled.noteKey, 'edit.mergeNone');

  // An empty palette is not a model either.
  const bare = mergeOffer({
    palette: new Palette(), volume: vol, building: false, deltaE: MERGE_DELTA_E,
  });
  eq('empty.enabled', bare.enabled, false);
  eq('empty.note', bare.noteKey, 'edit.mergeNoModel');

  // Every reason this returns has to exist in both languages, or the panel
  // shows a bare key (`CLAUDE.md`, "Правила проекта").
  for (const key of ['edit.mergeNoModel', 'edit.mergeBuilding', 'edit.mergeNone',
    'edit.mergeFree', 'edit.mergeReady']) {
    for (const lang of LANGUAGES) {
      eq(lang + ' has ' + key, Object.prototype.hasOwnProperty.call(STRINGS[lang], key), true);
    }
  }
}

/**
 * The body of a function, from its opening brace to the matching one.
 * @param {string} src
 * @param {string} head text just before the `{`
 * @returns {string|null}
 */
function blockAfter(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const open = src.indexOf('{', at + head.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The wiring, read from `src/main.js`. */
async function checkWiring() {
  const src = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');
  const body = blockAfter(src, 'function refreshMergeOffer()');
  if (body === null) {
    bad.push('refreshMergeOffer() not found in src/main.js - this check needs rewriting');
    return;
  }
  cases += 3;
  if (!/mergeOffer\(/.test(body)) {
    bad.push('refreshMergeOffer() does not ask mergeOffer() for the decision');
  }
  if (!/\.disabled\s*=\s*!\s*\w+\.enabled/.test(body)) {
    bad.push('the button is not disabled from the offer');
  }
  if (!/classList\.toggle\(\s*'warn'\s*,\s*\w+\.warn\s*\)/.test(body)) {
    bad.push('the note class is not toggled from the offer');
  }

  // Every place that changes which colours the palette holds has to refresh the
  // offer, or the panel keeps promising a merge of colours that are gone.
  // `applyRecolour()` is the one that did not: the live recolour touches no
  // voxel, so nothing else on that path rebuilds the palette panel.
  const recolour = blockAfter(src, 'function applyRecolour()');
  if (recolour === null) {
    bad.push('applyRecolour() not found in src/main.js - this check needs rewriting');
  } else {
    cases++;
    if (!/refreshMergeOffer\(\)/.test(recolour)) {
      bad.push('applyRecolour() does not refresh the merge offer, so the plan goes stale');
    }
  }

  // The click has to answer out loud on the paths the button cannot reach by
  // mouse: the keyboard, and a plan that went stale.
  const click = blockAfter(src, 'function mergeColors()');
  if (click === null) {
    bad.push('mergeColors() not found in src/main.js - this check needs rewriting');
    return;
  }
  cases += 2;
  const head = click.slice(0, click.indexOf('const plan = mergePlan'));
  if (!/state\.building\)\s*\{[^}]*status\(/.test(head)) {
    bad.push('mergeColors() returns on a running build without saying so');
  }
  if (!/!state\.volume\)\s*\{[^}]*status\(/.test(head)) {
    bad.push('mergeColors() returns without a model without saying so');
  }
}

export async function run() {
  checkDecision();
  await checkWiring();
  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases (7 button states measured, 6 wiring reads)'
      : bad.join('; '),
  };
}
