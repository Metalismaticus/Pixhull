// @ts-check
/**
 * The tie in `facingOf` (`src/core/field.js`), measured through the product.
 *
 * When a surface leans as much "up" as it leans "forward", the choice of which
 * drawing paints it is genuinely tied, and the rule is that the upright view
 * wins: that is where the artist put the glass, the grille and the door, while
 * a top view is mostly a plan outline (`docs/DECISIONS.md`, "На 45° ничья
 * отдаётся вертикальным видам"). Three separate BUGS entries about the cab
 * hang off that one `if`, and until this check existed nothing in the bench
 * touched it: inverting the rule outright left the whole run green at 28/0
 * (measured 2026-09-24), so any repair aimed at the cab had nothing holding it
 * in place.
 *
 * What is measured is not the function but its consequence - the colour that
 * ends up on the treads of a staircase after a full carve, which is what the
 * artist sees. Each view draws in its own colour (`VIEW_COLOUR`), so a tread
 * carrying the front view's red was handed over by the tie and a tread
 * carrying the top view's grey was not.
 *
 * Three shapes, three different jobs:
 *
 * - `wedge`, a plain 45-degree ramp, is the tie itself: most of its treads
 *   must come from the front drawing;
 * - `cab` is the tie next to flat roof and flat nose, where it has to fire on
 *   the slope and not on the corners either side of it - so its count is
 *   pinned from both sides, not just from below;
 * - `step` has no diagonal anywhere: every face points squarely along its own
 *   axis and has exactly one drawing entitled to it, so the slack must not
 *   arbitrate there at all. This is the "нельзя ломать" half - the same
 *   property `carve/cube-faces` guards on a bare cube.
 *
 * Red without the rule, all measured 2026-09-24 at N=24:
 *
 * - `return maxDir` in place of `return bestUp` (the rule inverted): wedge
 *   464 -> 68 front-coloured treads, cab 112 -> 0;
 * - the `if (bestUpDot > maxDot - TIE)` line deleted: identical, 68 and 0;
 * - `TIE` widened from 0.08 to 1.0 (the slack arbitrating everything): cab
 *   112 -> 192, above the upper bound here.
 *
 * `TIE` narrowed to 0.02 gives cab 110 against 112, which this check does not
 * separate: on these shapes the tie is either taken or not, and the width of
 * the slack barely shows. The bound below is set where inversion falls, not
 * where narrowing does.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SHAPES, VIEW_COLOUR, viewsOfShape } from '../fixtures.mjs';

const N = 24;

/** Packed colour -> view name, so a face can name the drawing that painted it. */
const OWNER = new Map(
  Object.entries(VIEW_COLOUR).map(([name, [r, g, b]]) => [(r << 16) | (g << 8) | b, name]),
);

/**
 * Carve one shape and tally which drawing painted each exposed top face.
 * @param {string} shape a key of SHAPES
 * @returns {Map<string, number>}
 */
function treadsOf(shape) {
  const views = viewsOfShape(N, SHAPES[shape](N));
  const palette = new Palette();
  const { volume } = carve(views, N, palette, { mirrorMissing: false });
  /** @type {Map<string, number>} */
  const tally = new Map();
  volume.forEachSolid((x, y, z) => {
    if (volume.get(x, y + 1, z)) return;
    const packed = palette.colors[volume.getFace(x, y, z, 2)] | 0;
    const name = OWNER.get(packed) ?? 'other';
    tally.set(name, (tally.get(name) ?? 0) + 1);
  });
  return tally;
}

export function run() {
  const fails = [];
  const parts = [];

  // The ramp is the tie: measured 464 of 576 treads painted from the front,
  // and 68 with the rule gone. The floor sits between the two, nearer the
  // broken figure so an unrelated change of a few faces does not go red.
  const wedge = treadsOf('wedge');
  const wedgeFront = wedge.get('front') ?? 0;
  parts.push(`wedge front-painted treads ${wedgeFront}`);
  if (wedgeFront < 300) fails.push(`wedge: ${wedgeFront} front-painted treads, want >= 300`);

  // The cab pins the tie from both sides: 112 now, 0 with the rule gone, 192
  // with the slack widened to arbitrate everything.
  const cab = treadsOf('cab');
  const cabFront = cab.get('front') ?? 0;
  parts.push(`cab ${cabFront}`);
  if (cabFront < 60) fails.push(`cab: ${cabFront} front-painted treads, want >= 60`);
  if (cabFront > 150) fails.push(`cab: ${cabFront} front-painted treads, want <= 150`);

  // And the step has no tie to take: every one of its 576 exposed top faces
  // points straight up, and the top view is the only drawing entitled to them.
  const step = treadsOf('step');
  const stepTop = step.get('top') ?? 0;
  const stepOther = [...step.entries()].reduce((n, [k, v]) => (k === 'top' ? n : n + v), 0);
  parts.push(`step ${stepTop} top / ${stepOther} taken by another view`);
  if (stepOther !== 0) fails.push(`step: ${stepOther} top faces painted by a view that is not the top`);

  return { ok: fails.length === 0, detail: fails.length ? fails.join('; ') : parts.join(', ') };
}
