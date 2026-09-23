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
 */

import { VIEW_AXES } from './views.js';

/** Resolution of the normalised stamp each silhouette is reduced to. */
const SIGNATURE = 32;

/** Shapes must overlap at least this much to be worth suspecting. */
export const SHAPE_THRESHOLD = 0.7;

/** And their colours must agree this often across the overlap. */
export const COLOUR_THRESHOLD = 0.6;

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
 * @returns {Array<{a: string, b: string, similarity: number, colour: number}>} worst first
 */
export function findLookalikeViews(rasters, N) {
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
