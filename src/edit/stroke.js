// @ts-check
/**
 * Turning a pointer drag into a line rather than a row of dots.
 *
 * A pointer event arrives once per frame at best, and a hand moving quickly
 * covers dozens of voxels between two of them. Applying the tool only where an
 * event landed leaves everything in between untouched, which is the dotted
 * stroke people report. So the drag is resampled: between the previous point
 * and the new one the tool runs at fixed steps small enough that no voxel the
 * path crossed is skipped.
 *
 * The step is a fraction of a voxel, not a fixed number of pixels, so the cost
 * follows the voxels painted instead of the zoom: a stroke that crosses ten
 * voxels costs the same number of rays whether the model fills the window or
 * sits in a corner of it.
 */

/**
 * Screen distance between two samples, as a share of one voxel.
 *
 * Measured, not guessed: a solid 32-cube sampled along straight screen paths at
 * 6 yaws x 5 pitches x 6 zooms (1 to 40 px per voxel), 900 paths in all,
 * against a reference sampled every 0.02 px. A step of 1/8 voxel still skipped
 * 20 of the 32002 faces on those paths, up to 3 in one gesture; 1/16 skipped
 * none. One event per move, which is what the code did before, skipped
 * essentially the whole path - 31309 of 32002 faces over the same sweep.
 */
export const STEP_VOXELS = 1 / 16;

/**
 * Ceiling on samples for one segment.
 *
 * Only a pointer jump of hundreds of pixels at the furthest zoom out can reach
 * it - a window switch, or a drag resumed after the tab was busy. Past that
 * point the straight line between two such far-apart points is a guess anyway,
 * and the cap keeps one stray event from costing thousands of raycasts.
 */
export const MAX_STEPS = 4096;

/**
 * Step length in device pixels for the current zoom.
 * @param {number} pixelsPerVoxel
 * @returns {number}
 */
export function strokeStepPx(pixelsPerVoxel) {
  return Math.max(1e-3, pixelsPerVoxel * STEP_VOXELS);
}

/**
 * Points along the segment from (x0, y0) to (x1, y1), spaced no further apart
 * than `stepPx`.
 *
 * The start is left out and the end is always included: the caller has already
 * applied the tool where the previous event landed, and the point the pointer
 * is at now must be applied exactly, not approximately.
 *
 * @param {number} x0 @param {number} y0
 * @param {number} x1 @param {number} y1
 * @param {number} stepPx
 * @returns {Array<[number, number]>}
 */
export function strokeSamples(x0, y0, x1, y1, stepPx) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const step = Math.max(1e-3, stepPx);
  let n = Math.ceil(len / step);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > MAX_STEPS) n = MAX_STEPS;
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push([x0 + (dx * i) / n, y0 + (dy * i) / n]);
  }
  return out;
}
