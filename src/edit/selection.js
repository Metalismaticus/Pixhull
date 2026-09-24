// @ts-check
/**
 * The block a box drag leaves behind.
 *
 * The box tool used to be a gesture that applied itself the moment the button
 * came up: depth came from the brush slider, so the third dimension was chosen
 * before the first two were drawn, and there was nothing to look at before the
 * voxels moved. Here the drag only produces a cuboid; what to do with it is a
 * separate command, and its faces can be pulled about in between.
 *
 * Everything in this file is arithmetic on voxel coordinates and volumes - no
 * GL, no DOM - so a block's size, its counts and the face a ray arms can all be
 * measured in Node rather than squinted at on screen.
 */

import { DIRS } from '../core/volume.js';
import { applyBox } from './tools.js';

/**
 * Cells past which "how many are solid" is not worked out.
 *
 * Not the owner's number. A block is legal at any size, but the count walks
 * every cell in it, and the walk happens again on every pointer move while a
 * face is being dragged. Two million is about eight frames' worth of work on
 * the machine this was written on, and a block that big is a whole-model
 * operation the user is not aiming with anyway. Past it the panel says "not
 * counted" rather than a number it did not count.
 */
export const COUNT_LIMIT = 2000000;

/**
 * @typedef {{min: [number, number, number], max: [number, number, number]}} Extent
 */

/**
 * Keep a cuboid inside the grid, min below max.
 * @param {Extent} extent
 * @param {[number, number, number]} dims
 * @returns {Extent}
 */
export function clampExtent(extent, dims) {
  const min = /** @type {[number, number, number]} */ ([0, 0, 0]);
  const max = /** @type {[number, number, number]} */ ([0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const lo = Math.min(extent.min[i], extent.max[i]);
    const hi = Math.max(extent.min[i], extent.max[i]);
    min[i] = Math.max(0, Math.min(dims[i] - 1, lo));
    max[i] = Math.max(0, Math.min(dims[i] - 1, hi));
  }
  return { min, max };
}

/**
 * The block a fresh drag covers: a rectangle in the plane of the face it began
 * on, exactly one cell deep.
 *
 * One cell, not `brush + 1`: depth is what the user now sets by pulling a face,
 * and taking it from the brush slider as well would mean two controls for one
 * number, disagreeing whenever the slider was last touched for a brush.
 *
 * @param {{x: number, y: number, z: number, face: number}} anchor
 * @param {[number, number, number]} corner far corner, in voxel coordinates
 * @param {[number, number, number]} dims
 * @returns {Extent}
 */
export function dragExtent(anchor, corner, dims) {
  const axis = anchor.face >> 1;
  const a = [anchor.x, anchor.y, anchor.z];
  const min = /** @type {[number, number, number]} */ ([0, 0, 0]);
  const max = /** @type {[number, number, number]} */ ([0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    if (i === axis) {
      min[i] = a[i];
      max[i] = a[i];
    } else {
      min[i] = Math.min(a[i], corner[i]);
      max[i] = Math.max(a[i], corner[i]);
    }
  }
  return clampExtent({ min, max }, dims);
}

/**
 * Move one face of the block to a new plane.
 *
 * `plane` is in corner coordinates, the same space the outline is drawn in: the
 * +X face of a block whose last cell is 7 sits at 8. The opposite face is never
 * crossed - the smallest block is one cell on every axis - and the whole thing
 * stays inside the grid.
 *
 * @param {Extent} extent
 * @param {number} face 0..5, even faces on the +axis side
 * @param {number} plane where that face should go, in corner coordinates
 * @param {[number, number, number]} dims
 * @returns {Extent}
 */
export function resizeExtent(extent, face, plane, dims) {
  const axis = face >> 1;
  const min = /** @type {[number, number, number]} */ ([...extent.min]);
  const max = /** @type {[number, number, number]} */ ([...extent.max]);
  if (face % 2 === 0) {
    // +axis side: the face lies one past the last cell.
    max[axis] = Math.max(min[axis], Math.min(dims[axis] - 1, Math.round(plane) - 1));
  } else {
    min[axis] = Math.min(max[axis], Math.max(0, Math.round(plane)));
  }
  return { min, max };
}

/** @param {Extent} e @returns {[number, number, number]} */
export function extentSize(e) {
  return [e.max[0] - e.min[0] + 1, e.max[1] - e.min[1] + 1, e.max[2] - e.min[2] + 1];
}

/** @param {Extent} e @returns {number} */
export function extentCells(e) {
  const [w, h, d] = extentSize(e);
  return w * h * d;
}

/**
 * How much of the block is already solid.
 *
 * `counted` is false past `COUNT_LIMIT`: the two numbers are then unknown, not
 * zero, and the panel has to say so rather than print a nought it never
 * measured.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {Extent} extent
 * @returns {{solid: number, empty: number, cells: number, counted: boolean}}
 */
export function countBlock(vol, extent) {
  const cells = extentCells(extent);
  if (cells > COUNT_LIMIT) return { solid: 0, empty: 0, cells, counted: false };
  let solid = 0;
  for (let z = extent.min[2]; z <= extent.max[2]; z++) {
    for (let y = extent.min[1]; y <= extent.max[1]; y++) {
      for (let x = extent.min[0]; x <= extent.max[0]; x++) {
        if (vol.get(x, y, z)) solid++;
      }
    }
  }
  return { solid, empty: cells - solid, cells, counted: true };
}

/**
 * Which face of the block a ray enters through, or null when it misses.
 *
 * A slab test on the block's outer box. The entry face is by construction the
 * one turned towards the camera, which is exactly the set of faces the user is
 * allowed to grab: a handle on the far side would move the wrong way under the
 * hand.
 *
 * @param {Extent} extent
 * @param {[number, number, number]} origin
 * @param {[number, number, number]} dir
 * @returns {number | null} face index 0..5
 */
export function boxFaceUnderRay(extent, origin, dir) {
  let t0 = -Infinity;
  let t1 = Infinity;
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    const lo = extent.min[a];
    const hi = extent.max[a] + 1;
    if (Math.abs(dir[a]) < 1e-12) {
      if (origin[a] < lo || origin[a] > hi) return null;
      continue;
    }
    let ta = (lo - origin[a]) / dir[a];
    let tb = (hi - origin[a]) / dir[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) { t0 = ta; axis = a; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (axis < 0 || t1 < 0) return null;
  // Stepping along +axis enters through the -axis face, as elsewhere.
  return axis * 2 + (dir[axis] > 0 ? 1 : 0);
}

/**
 * Where a ray comes closest to the axis line through a point - the coordinate a
 * dragged face should move to.
 *
 * The pointer moves in two dimensions and the face in one, so the honest
 * reading is the point on the face's axis nearest the ray. Looking straight
 * down the axis leaves nothing to read and the answer is null rather than a
 * wild number.
 *
 * @param {[number, number, number]} origin
 * @param {[number, number, number]} dir
 * @param {[number, number, number]} through a point on the axis line
 * @param {number} axis
 * @returns {number | null} coordinate along `axis`
 */
export function axisPointFromRay(origin, dir, through, axis) {
  const u = [0, 0, 0];
  u[axis] = 1;
  const w0 = [through[0] - origin[0], through[1] - origin[1], through[2] - origin[2]];
  const b = dir[axis];
  const c = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  const d = w0[axis];
  const e = dir[0] * w0[0] + dir[1] * w0[1] + dir[2] * w0[2];
  const denom = c - b * b;
  if (Math.abs(denom) < 1e-9) return null;
  const tt = (b * e - c * d) / denom;
  return through[axis] + tt;
}

/**
 * Do one of the three things to the block.
 *
 * Fill and delete are `applyBox`, which already writes one history entry,
 * mirrors across X and colours whatever face the change exposed. Paint is new:
 * it touches no geometry, so it cannot open a hole, and it reports the face
 * bytes it actually rewrote rather than six times the voxel count.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {Extent} extent
 * @param {'fill'|'delete'|'paint'} action
 * @param {{color: number, symmetryX?: boolean, history?: import('./history.js').History}} opts
 * @returns {{voxels: number, faces: number}}
 */
export function applySelection(vol, extent, action, opts) {
  if (action === 'fill' || action === 'delete') {
    const voxels = applyBox(vol, extent, {
      fill: action === 'fill',
      color: opts.color,
      symmetryX: opts.symmetryX,
      history: opts.history,
    });
    return { voxels, faces: 0 };
  }

  const h = opts.history;
  let voxels = 0;
  let faces = 0;
  const run = (/** @type {boolean} */ mirror) => {
    for (let z = extent.min[2]; z <= extent.max[2]; z++) {
      for (let y = extent.min[1]; y <= extent.max[1]; y++) {
        for (let x0 = extent.min[0]; x0 <= extent.max[0]; x0++) {
          const x = mirror ? vol.nx - 1 - x0 : x0;
          if (!vol.inBounds(x, y, z)) continue;
          if (!vol.get(x, y, z)) continue;
          let changed = 0;
          for (let d = 0; d < 6; d++) {
            if (vol.getFace(x, y, z, d) !== opts.color) changed++;
          }
          if (changed === 0) continue;
          h?.touch(vol, x, y, z);
          vol.setAllFaces(x, y, z, opts.color);
          voxels++;
          faces += changed;
        }
      }
    }
  };
  run(false);
  if (opts.symmetryX) run(true);
  return { voxels, faces };
}

/**
 * The outward normal of a block face, for nudging the cell grid off the
 * surface it lies on.
 * @param {number} face
 * @returns {[number, number, number]}
 */
export function faceNormal(face) {
  const n = DIRS[face];
  return [n[0], n[1], n[2]];
}
