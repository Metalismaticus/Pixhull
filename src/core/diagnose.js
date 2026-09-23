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
 * Measured on a real reference sheet whose bottom two drawings were three-
 * quarter beauty shots rather than projections: top vs front scored 0.79 and
 * top vs back 0.81, against 0.52 for the genuine side view. A threshold of 0.7
 * separates them comfortably.
 */

import { VIEW_AXES } from './views.js';

/** Resolution of the normalised stamp each silhouette is reduced to. */
const SIGNATURE = 32;

/** Above this, two views spanning different axes are almost certainly the same drawing. */
export const LOOKALIKE_THRESHOLD = 0.7;

/**
 * Reduce a mask to a fixed stamp of its own bounding box.
 *
 * Normalising away position and aspect is the point: the same drawing fitted
 * into two differently shaped boxes has to still register as the same shape.
 *
 * @param {Uint8Array} mask
 * @param {number} N grid size
 * @returns {Uint8Array} SIGNATURE x SIGNATURE
 */
export function silhouetteSignature(mask, N) {
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
  const sig = new Uint8Array(SIGNATURE * SIGNATURE);
  if (x1 < 0) return sig;

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  for (let b = 0; b < SIGNATURE; b++) {
    const v = y0 + Math.floor(((b + 0.5) * h) / SIGNATURE);
    for (let a = 0; a < SIGNATURE; a++) {
      const u = x0 + Math.floor(((a + 0.5) * w) / SIGNATURE);
      sig[b * SIGNATURE + a] = mask[v * N + u];
    }
  }
  return sig;
}

/** Intersection over union. @param {Uint8Array} a @param {Uint8Array} b */
function overlap(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) intersection++;
    if (a[i] || b[i]) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pairs of views that span different axes yet look the same.
 *
 * @param {Record<string, {mask: Uint8Array}>} rasters keyed by view name
 * @param {number} N grid size
 * @returns {Array<{a: string, b: string, similarity: number}>} worst first
 */
export function findLookalikeViews(rasters, N) {
  const names = Object.keys(rasters);
  /** @type {Record<string, Uint8Array>} */
  const signatures = {};
  for (const name of names) signatures[name] = silhouetteSignature(rasters[name].mask, N);

  const found = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const axesA = VIEW_AXES[a];
      const axesB = VIEW_AXES[b];
      // Opposite views share their axes and are meant to match.
      if (!axesA || !axesB || (axesA[0] === axesB[0] && axesA[1] === axesB[1])) continue;
      const similarity = overlap(signatures[a], signatures[b]);
      if (similarity >= LOOKALIKE_THRESHOLD) found.push({ a, b, similarity });
    }
  }
  return found.sort((x, y) => y.similarity - x.similarity);
}
