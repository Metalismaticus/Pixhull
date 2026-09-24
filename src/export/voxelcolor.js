// @ts-check
/**
 * One colour out of six: the single rule every export that has to flatten a
 * voxel obeys.
 *
 * A Pixhull voxel carries six palette bytes, one per face. `.vox` wants one
 * colour per cube; a stack of PNG slices wants one colour per pixel. Both have
 * to throw five of them away, and doing that twice, in two modules, by two
 * slightly different rules, is how a model ends up looking like two different
 * models depending on which button was pressed. So the rule lives here and
 * nowhere else.
 *
 * The rule, in order:
 *
 * 1. **The face the viewer looks at**, when the export has one. A stack of
 *    slices is only ever seen along its stacking axis, so the pixel of a voxel
 *    is that voxel's top face - it is a projection, not a guess. `.vox` passes
 *    no `facing`, because a MagicaVoxel cube is seen from every side and no
 *    face has a better claim than the others.
 * 2. **A vote among the faces you can actually see.** A tyre whose visible
 *    faces are all black stays black even if a buried face is not; a body
 *    panel takes the panel's colour rather than whatever is on its underside.
 *    Buried faces get no vote, because hidden geometry should not decide how
 *    the model looks.
 * 3. **Any colour the voxel carries**, then the caller's fallback. Only fully
 *    enclosed voxels get this far, and they carry no colour at all: the carve
 *    paints what a view can see, and nothing sees them.
 *
 * Why the first step is not folded into the vote, measured on the lorry
 * (`tests/art/truck.png`, six cells, nothing mirrored) 2026-09-24: with the
 * plain vote, 121 of the 28 465 slice pixels a stack actually shows at 256
 * come out a different colour than the face pointing at the viewer (246 of
 * 7129 at 128). Few - but they are not near misses: mean RGB distance 49.8 at
 * 256 and 244.1 at 128, worst 354.5, i.e. black where the art is white. The
 * later steps cost the stack nothing: 0 of those visible pixels reach step 2
 * or 3 at either size, because a face a stack shows is a face a view painted.
 */

import { DIRS } from '../core/volume.js';

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {number} x @param {number} y @param {number} z
 * @param {{facing?: number, fallback?: number}} [opts]
 *   `facing` is a `DIR_*` index the export is looking along; `fallback` is the
 *   palette index for a voxel that carries no colour at all (default 1).
 * @returns {number} palette index, never 0
 */
export function voxelColor(vol, x, y, z, opts = {}) {
  const fallback = opts.fallback ?? 1;
  const facing = opts.facing;

  if (facing !== undefined) {
    const [fx, fy, fz] = DIRS[facing];
    if (!vol.get(x + fx, y + fy, z + fz)) {
      const c = vol.getFace(x, y, z, facing);
      if (c !== 0) return c;
    }
  }

  /** @type {Map<number, number>} */
  const votes = new Map();
  let any = 0;
  for (let d = 0; d < 6; d++) {
    const [dx, dy, dz] = DIRS[d];
    const c = vol.getFace(x, y, z, d);
    if (c !== 0 && any === 0) any = c;
    if (vol.get(x + dx, y + dy, z + dz)) continue; // buried faces get no vote
    if (c === 0) continue;
    votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [c, n] of votes) {
    if (n > bestN) { bestN = n; best = c; }
  }
  return best || any || fallback;
}
