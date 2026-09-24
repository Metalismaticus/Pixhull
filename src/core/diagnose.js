// @ts-check
/**
 * Telling the artist when a sheet cannot work.
 *
 * Shape-from-silhouette fails silently and expensively. Hand a front slot a
 * drawing that is really a second top view and the carve still runs, still
 * reports a voxel count, and hands back a solid block of debris. Nothing in the
 * numbers says why, so the natural conclusion is that the tool is broken.
 *
 * It is checkable, though. Views that span different axis pairs should not look
 * alike: front spans (x, y) and top spans (x, z), so if their silhouettes
 * match, the same drawing has been used for both. Opposite views - front and
 * back, left and right, top and bottom - are expected to match and are exempt.
 *
 * Silhouette alone is not enough evidence, though. A box lorry’s side view and
 * its underside are both rectangles and scored 0.83 against each other while
 * being entirely different drawings. So the colours have to agree as well: if
 * one drawing really is in two slots, the palette indices line up too, and a
 * red cab against a grey chassis does not.
 *
 * Measured: on a sheet whose bottom two drawings were three-quarter beauty
 * shots, top against front matched on shape *and* colour. On the lorry, shape
 * matched and colour did not.
 *
 * And neither is enough on its own, because the stamp below normalises aspect
 * away on purpose. The built-in demo car scored 0.81 shape and 0.86 colour
 * against itself - front against side - while the two drawings are 12x10 and
 * 23x10. Proportions are checked first now: a drawing that really is in two
 * slots is the same file and has exactly the same proportions.
 */

import { VIEW_AXES } from './views.js';

/** Resolution of the normalised stamp each silhouette is reduced to. */
const SIGNATURE = 32;

/** Shapes must overlap at least this much to be worth suspecting. */
export const SHAPE_THRESHOLD = 0.7;

/** And their colours must agree this often across the overlap. */
export const COLOUR_THRESHOLD = 0.6;

/**
 * How far two drawings' own proportions may differ and still be suspected of
 * being one drawing used twice.
 *
 * The stamp above deliberately throws aspect away, and that is what made the
 * built-in demo accuse itself: a car seen head-on (12x10 of drawing) and the
 * same car seen from the side (23x10) are both squashed into the same square,
 * after which they overlap 81% and - being a five-colour car striped the same
 * way top to bottom, because both views share the vertical axis - agree on
 * colour 86% of the time. Neither number is evidence, because both survive the
 * proportions being wrong by a factor of 1.9.
 *
 * One drawing sitting in two slots has *exactly* the same proportions: it is
 * the same file. So the tolerance only has to leave room for trimming, which
 * is why it is small. It is deliberately not a shape threshold: raising that
 * to 0.9 would throw away the case this diagnosis was written for - a sheet
 * whose bottom two cells held three-quarter beauty shots.
 *
 * That rescue is conditional, and the condition matters: the gate keeps the
 * pair only when *both* members are three-quarter shots, because then they are
 * two different drawings of one object at one size and their proportions agree
 * (1.000-1.011 measured). A three-quarter shot sitting in one slot against a
 * true orthographic drawing in the other is a different story: on a non-faceted
 * object the proportions come apart by 1.2-1.9 and the gate drops the pair
 * silently. Measured on the owner's truck sheet (`tests/art/truck.png`, six
 * cells, trimmed): front 308x349 = 0.883, right 505x291 = 1.735, top
 * 479x244 = 1.963; a three-quarter shot at 45 degrees of yaw estimates to
 * 1.647, so its ratio to front is 1.87 and to top is 1.19 - both above 1.15,
 * and no warning is produced.
 *
 * Chosen, not measured from a sheet we have: demo pairs measure 1.92, 2.20 and
 * 4.22; a drawing duplicated into another slot measures exactly 1.00
 * (`tests/views/lookalike-demo.mjs`, `tests/views/lookalike-duplicate.mjs`).
 */
export const PROPORTION_TOLERANCE = 1.15;

/**
 * Reduce a mask to a fixed stamp of its own bounding box.
 *
 * Normalising away position and aspect is the point: the same drawing fitted
 * into two differently shaped boxes has to still register as the same shape.
 *
 * @param {Uint8Array} mask
 * @param {number} N grid size
 * @param {Uint8Array} [color] palette index per cell, sampled alongside the shape
 * @returns {{shape: Uint8Array, color: Uint8Array}} SIGNATURE x SIGNATURE each
 */
export function silhouetteSignature(mask, N, color) {
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      if (!mask[v * N + u]) continue;
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
  }
  const shape = new Uint8Array(SIGNATURE * SIGNATURE);
  const tone = new Uint8Array(SIGNATURE * SIGNATURE);
  if (x1 < 0) return { shape, color: tone };

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  for (let b = 0; b < SIGNATURE; b++) {
    const v = y0 + Math.floor(((b + 0.5) * h) / SIGNATURE);
    for (let a = 0; a < SIGNATURE; a++) {
      const u = x0 + Math.floor(((a + 0.5) * w) / SIGNATURE);
      shape[b * SIGNATURE + a] = mask[v * N + u];
      if (color) tone[b * SIGNATURE + a] = color[v * N + u];
    }
  }
  return { shape, color: tone };
}

/**
 * Shape overlap, and how often the colours agree where both are solid.
 * @param {{shape: Uint8Array, color: Uint8Array}} a
 * @param {{shape: Uint8Array, color: Uint8Array}} b
 */
function compare(a, b) {
  let intersection = 0;
  let union = 0;
  let sameColour = 0;
  for (let i = 0; i < a.shape.length; i++) {
    const both = a.shape[i] && b.shape[i];
    if (both) {
      intersection++;
      if (a.color[i] === b.color[i]) sameColour++;
    }
    if (a.shape[i] || b.shape[i]) union++;
  }
  return {
    shape: union === 0 ? 0 : intersection / union,
    colour: intersection === 0 ? 0 : sameColour / intersection,
  };
}

/**
 * Pairs of views that span different axes yet look the same.
 *
 * @param {Record<string, {mask: Uint8Array, color: Uint8Array}>} rasters keyed by view name
 * @param {number} N grid size
 * @param {Record<string, number>} [proportions] width / height of each view's own
 *   trimmed drawing, before the grid ever touched it. Views whose proportions
 *   are further apart than `PROPORTION_TOLERANCE` cannot be one drawing twice
 *   and are not compared. Omitted, the gate is skipped.
 * @returns {Array<{a: string, b: string, similarity: number, colour: number}>} worst first
 */
export function findLookalikeViews(rasters, N, proportions) {
  const names = Object.keys(rasters);
  /** @type {Record<string, {shape: Uint8Array, color: Uint8Array}>} */
  const signatures = {};
  for (const name of names) {
    signatures[name] = silhouetteSignature(rasters[name].mask, N, rasters[name].color);
  }

  const found = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const axesA = VIEW_AXES[a];
      const axesB = VIEW_AXES[b];
      // Opposite views share their axes and are meant to match.
      if (!axesA || !axesB || (axesA[0] === axesB[0] && axesA[1] === axesB[1])) continue;
      // Proportions first: it is the one property a duplicated drawing cannot
      // fail, and the one the stamp cannot see.
      if (proportions) {
        const pa = proportions[a];
        const pb = proportions[b];
        if (pa > 0 && pb > 0 && Math.max(pa / pb, pb / pa) > PROPORTION_TOLERANCE) continue;
      }
      const { shape, colour } = compare(signatures[a], signatures[b]);
      // Both have to agree. Shape alone convicts every boxy object of being
      // a duplicate of itself seen from another side.
      if (shape >= SHAPE_THRESHOLD && colour >= COLOUR_THRESHOLD) {
        found.push({ a, b, similarity: shape, colour });
      }
    }
  }
  return found.sort((x, y) => y.similarity * y.colour - x.similarity * x.colour);
}
