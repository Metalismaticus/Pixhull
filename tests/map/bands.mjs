// @ts-check
/**
 * The disagreement map says which drawings disagree, and by how much.
 *
 * Red without the fix: the map does not exist at all before this item, so
 * `src/core/disagree.js` fails to import. Red after, if the bands move: the
 * thresholds are pinned from both sides here, and the case the map exists to
 * catch - two views giving one voxel colours 23-26 dE apart - is checked by
 * building exactly that and demanding a loud band.
 *
 * Numbers from this run, 2026-09-24, on a 16-cell cube of flat views.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { bandOf, BAND_LONELY, DISPUTED_FROM, mapAt } from '../../src/core/disagree.js';
import { ciede2000Packed } from '../../src/core/color.js';
import { makeFlat, viewsFromImages } from '../fixtures.mjs';

const N = 16;

/** Six flat drawings, every one the same colour: nothing to disagree about. */
function agreeing(rgb) {
  const images = {};
  for (const name of ['front', 'back', 'right', 'left', 'top', 'bottom']) {
    images[name] = makeFlat(N, N, rgb);
  }
  return images;
}

function build(images) {
  const palette = new Palette();
  const { volume, map } = carve(viewsFromImages(images), N, palette, { map: true });
  return { volume, map, palette };
}

export function run() {
  const notes = [];
  let ok = true;
  const fail = (why) => { ok = false; notes.push(why); };

  // 1. Band edges, both sides of every threshold.
  const edges = [
    [60, 0], [50, 0], [49.9, 1], [25, 1], [24.9, 2], [10, 2],
    [9.9, 3], [3, 3], [2.9, 4], [0, 4], [-1, BAND_LONELY],
  ];
  for (const [d, want] of edges) {
    if (bandOf(d) !== want) fail(`band of ${d} is ${bandOf(d)}, want ${want}`);
  }

  // 2. Views that agree: not one disputed voxel, and every voxel accounted for.
  {
    const { map } = build(agreeing([200, 120, 60]));
    if (map.disputed !== 0) fail(`agreeing cube disputes ${map.disputed}`);
    let sum = 0;
    for (const c of map.counts) sum += c;
    if (sum !== map.total) fail(`counts sum ${sum} against total ${map.total}`);
    if (map.counts[BAND_LONELY] + map.counts[4] !== map.total) {
      fail('agreeing cube used a band above "agree"');
    }
    notes.push(`agree ${map.total} seen, ${map.disputed} disputed`);
  }

  // 3. The headlight case: one view 23-26 dE away from the rest. The voxels on
  //    the shared edge are seen by two views and must land in a loud band.
  {
    const cream = [251, 245, 224];
    const amber = [249, 200, 63];
    const gap = ciede2000Packed(0xfbf5e0, 0xf9c83f);
    if (!(gap > 20 && gap < 30)) fail(`fixture pair is ${gap.toFixed(2)} dE, expected 23.15`);
    const images = agreeing(amber);
    images.front = makeFlat(N, N, cream);
    const { map } = build(images);
    if (map.disputed === 0) fail('headlight pair reported no dispute');
    // The top-front edge: seen by `top` (amber) and `front` (cream).
    const hit = mapAt(map, 5, N - 1, N - 1);
    if (!hit) fail('the top-front edge is in no view');
    else {
      if (Math.abs(hit.delta - gap) > 0.01) fail(`edge dE ${hit.delta.toFixed(2)}, want ${gap.toFixed(2)}`);
      if (hit.band !== 2) fail(`edge landed in band ${hit.band}, want 2 (10-25)`);
      if (hit.delta < DISPUTED_FROM) fail('the case the map exists to catch is not counted as disputed');
    }
    // A voxel in the middle of the front face is seen by `front` alone.
    const lonely = mapAt(map, 5, 5, N - 1);
    if (!lonely || lonely.band !== BAND_LONELY || lonely.delta !== -1) {
      fail('a voxel one view saw is not reported as "nothing to compare with"');
    }
    notes.push(`headlights ${gap.toFixed(2)} dE, ${map.disputed} disputed of ${map.total}`);
  }

  return { ok, detail: notes.join('; ') };
}
