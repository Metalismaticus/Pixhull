// @ts-check
/**
 * Editing operations.
 *
 * Carving from silhouettes cannot produce a concavity no view reveals, so hand
 * editing is not a convenience here - it is the other half of the method. These
 * are the operations that make the difference.
 *
 * Every operation that can expose a new face also heals it: palette index 0 is
 * discarded by the shader, so an unhealed face is a hole you can see through.
 */

import { DIRS } from '../core/volume.js';
import { addSeed } from './preview.js';

export const TOOLS = /** @type {const} */ (['paint', 'fill', 'erase', 'add', 'pick', 'box']);

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{min: [number, number, number], max: [number, number, number]}} extent
 * @param {{fill: boolean, color: number, symmetryX?: boolean, history?: import('./history.js').History}} opts
 * @returns {number} voxels changed
 */
export function applyBox(vol, extent, opts) {
  const h = opts.history;
  let changed = 0;

  const run = (mirror) => {
    for (let z = extent.min[2]; z <= extent.max[2]; z++) {
      for (let y = extent.min[1]; y <= extent.max[1]; y++) {
        for (let x0 = extent.min[0]; x0 <= extent.max[0]; x0++) {
          const x = mirror ? vol.nx - 1 - x0 : x0;
          if (!vol.inBounds(x, y, z)) continue;
          if (vol.get(x, y, z) === opts.fill) continue;
          h?.touch(vol, x, y, z);
          for (let d = 0; d < 6; d++) h?.touch(vol, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
          vol.set(x, y, z, opts.fill);
          if (opts.fill) vol.setAllFaces(x, y, z, opts.color);
          changed++;
        }
      }
    }
  };

  run(false);
  if (opts.symmetryX) run(true);

  if (changed > 0) {
    // The cuboid's whole neighbourhood can have gained exposed faces.
    const centre = {
      x: (extent.min[0] + extent.max[0]) >> 1,
      y: (extent.min[1] + extent.max[1]) >> 1,
      z: (extent.min[2] + extent.max[2]) >> 1,
    };
    const reach = Math.max(
      extent.max[0] - extent.min[0],
      extent.max[1] - extent.min[1],
      extent.max[2] - extent.min[2]
    );
    healAround(vol, centre, (reach >> 1) + 2, opts.color, h);
    if (opts.symmetryX) {
      healAround(vol, { ...centre, x: vol.nx - 1 - centre.x }, (reach >> 1) + 2, opts.color, h);
    }
  }

  return changed;
}

/**
 * @typedef {Object} ToolOptions
 * @property {typeof TOOLS[number]} tool
 * @property {number} color palette index to apply
 * @property {number} [brush] cube radius; 0 is a single voxel
 * @property {boolean} [faceOnly] paint just the face under the cursor
 * @property {boolean} [symmetryX] mirror the operation across the grid's X centre
 * @property {import('./history.js').History} [history]
 */

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {ToolOptions} opts
 * @returns {{changed: boolean, count: number, capped: boolean, picked?: number}}
 *   `count` is voxels for the brush tools and faces for fill; `capped` says the
 *   fill stopped at its limit rather than at the edge of the surface.
 */
export function applyTool(vol, hit, opts) {
  if (opts.tool === 'pick') {
    return { changed: false, count: 0, capped: false, picked: vol.getFace(hit.x, hit.y, hit.z, hit.face) };
  }

  const targets = opts.symmetryX ? [hit, mirrorX(vol, hit)] : [hit];
  let count = 0;
  let capped = false;
  for (const target of targets) {
    const one = runOne(vol, target, opts);
    count += one.count;
    capped = capped || one.capped;
  }
  return { changed: count > 0, count, capped };
}

/**
 * The same hit on the other side of the grid's X centre.
 *
 * Exported because the hover preview has to outline exactly what the mirrored
 * edit will touch; a second copy of this rule in the UI would drift from this
 * one, and the preview would start promising the wrong voxel.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 */
export function mirrorX(vol, hit) {
  // A face pointing +X becomes one pointing -X on the far side, and vice versa.
  const face = hit.face === 0 ? 1 : hit.face === 1 ? 0 : hit.face;
  return { x: vol.nx - 1 - hit.x, y: hit.y, z: hit.z, face };
}

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {ToolOptions} opts
 * @returns {{count: number, capped: boolean}}
 */
function runOne(vol, hit, opts) {
  const h = opts.history;
  const r = Math.max(0, Math.round(opts.brush ?? 0));

  if (opts.tool === 'paint') {
    if (opts.faceOnly && r === 0) {
      if (!vol.get(hit.x, hit.y, hit.z)) return NOTHING;
      if (vol.getFace(hit.x, hit.y, hit.z, hit.face) === opts.color) return NOTHING;
      h?.touch(vol, hit.x, hit.y, hit.z);
      vol.setFace(hit.x, hit.y, hit.z, hit.face, opts.color);
      return { count: 1, capped: false };
    }
    let count = 0;
    forEachInBrush(vol, hit, r, (x, y, z) => {
      if (!vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      if (opts.faceOnly) vol.setFace(x, y, z, hit.face, opts.color);
      else vol.setAllFaces(x, y, z, opts.color);
      count++;
    });
    return { count, capped: false };
  }

  if (opts.tool === 'erase') {
    let count = 0;
    forEachInBrush(vol, hit, r, (x, y, z) => {
      if (!vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      for (let d = 0; d < 6; d++) h?.touch(vol, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      vol.set(x, y, z, false);
      count++;
    });
    if (count > 0) healAround(vol, hit, r + 1, opts.color, h);
    return { count, capped: false };
  }

  if (opts.tool === 'add') {
    const seed = addSeed(hit);
    let count = 0;
    forEachInBrush(vol, seed, r, (x, y, z) => {
      if (vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      for (let d = 0; d < 6; d++) h?.touch(vol, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      vol.set(x, y, z, true);
      vol.setAllFaces(x, y, z, opts.color);
      count++;
    });
    if (count > 0) healAround(vol, seed, r + 1, opts.color, h);
    return { count, capped: false };
  }

  if (opts.tool === 'fill') {
    return fillSurface(vol, hit, opts.color, h);
  }

  return NOTHING;
}

/** Shared "the tool did not touch anything" answer. */
const NOTHING = /** @type {const} */ ({ count: 0, capped: false });

/**
 * Visit a cube of voxels centred on the hit.
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number}} c
 * @param {number} r
 * @param {(x: number, y: number, z: number) => void} fn
 */
function forEachInBrush(vol, c, r, fn) {
  for (let dz = -r; dz <= r; dz++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = c.x + dx, y = c.y + dy, z = c.z + dz;
        if (vol.inBounds(x, y, z)) fn(x, y, z);
      }
    }
  }
}

/**
 * Give a colour to any face that adding or removing voxels has just exposed.
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number}} c
 * @param {number} r
 * @param {number} color
 * @param {import('./history.js').History} [h]
 */
function healAround(vol, c, r, color, h) {
  forEachInBrush(vol, c, r + 1, (x, y, z) => {
    if (!vol.get(x, y, z)) return;
    let own = 0;
    for (let d = 0; d < 6; d++) {
      const f = vol.getFace(x, y, z, d);
      if (f !== 0) { own = f; break; }
    }
    if (own === 0) own = color;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (vol.get(x + dx, y + dy, z + dz)) continue;
      if (vol.getFace(x, y, z, d) !== 0) continue;
      h?.touch(vol, x, y, z);
      vol.setFace(x, y, z, d, own);
    }
  });
}

/** Stop a runaway fill from locking the tab on a large model. */
export const FILL_LIMIT = 400000;

/**
 * The faces a bucket fill would reach, without writing anything.
 *
 * Split out of `fillSurface` so the hover preview can outline the region it is
 * about to change with the very same walk that will change it. A preview that
 * disagreed with the edit would be worse than no preview, and two copies of a
 * flood fill would disagree sooner or later.
 *
 * The fill spreads to faces of the same colour and the same facing that are
 * connected by sight, following staircases up and down rather than stopping at
 * the edge of a flat plane.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {number} [limit] stop after this many faces
 * @returns {{cells: Array<[number, number, number]>, target: number, capped: boolean}}
 */
export function collectFillRegion(vol, hit, limit = FILL_LIMIT) {
  const face = hit.face;
  const target = vol.getFace(hit.x, hit.y, hit.z, face);
  if (!vol.get(hit.x, hit.y, hit.z)) return { cells: [], target, capped: false };

  const n = DIRS[face];
  // The four directions lying in the face's plane.
  const perp = [];
  for (let d = 0; d < 6; d++) {
    if ((d >> 1) !== (face >> 1)) perp.push(DIRS[d]);
  }

  const key = (x, y, z) => x + vol.nx * (y + vol.ny * z);
  const seen = new Set([key(hit.x, hit.y, hit.z)]);
  /** @type {Array<[number, number, number]>} */
  const queue = [[hit.x, hit.y, hit.z]];

  let head = 0;
  for (; head < queue.length && queue.length < limit; head++) {
    const [x, y, z] = queue[head];
    for (const p of perp) {
      // Same level, then one step out, then one step in - a voxel staircase
      // reads as one continuous surface to the eye, so the fill follows it.
      const candidates = [
        [x + p[0], y + p[1], z + p[2]],
        [x + p[0] + n[0], y + p[1] + n[1], z + p[2] + n[2]],
        [x + p[0] - n[0], y + p[1] - n[1], z + p[2] - n[2]],
      ];
      for (const [cx, cy, cz] of candidates) {
        if (!vol.inBounds(cx, cy, cz) || !vol.get(cx, cy, cz)) continue;
        if (vol.get(cx + n[0], cy + n[1], cz + n[2])) continue; // that face is buried
        if (vol.getFace(cx, cy, cz, face) !== target) continue;
        const k = key(cx, cy, cz);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push([cx, cy, cz]);
        break; // one candidate per direction is enough to continue the surface
      }
    }
  }

  // Reaching the limit means the walk stopped with neighbours still unvisited,
  // and the caller has to say so rather than report the cap as the answer.
  return { cells: queue, target, capped: head < queue.length };
}

/**
 * Bucket fill across the visible surface.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {number} color
 * @param {import('./history.js').History} [h]
 * @returns {{count: number, capped: boolean}}
 */
function fillSurface(vol, hit, color, h) {
  const face = hit.face;
  const target = vol.getFace(hit.x, hit.y, hit.z, face);
  // The early return is what keeps a dragged fill cheap: once the surface
  // already wears the new colour, every further sample costs one lookup
  // (`tests/edit/fill-drag.mjs`).
  if (target === color || !vol.get(hit.x, hit.y, hit.z)) return { count: 0, capped: false };

  const region = collectFillRegion(vol, hit, FILL_LIMIT);
  for (const [x, y, z] of region.cells) {
    h?.touch(vol, x, y, z);
    vol.setFace(x, y, z, face, color);
  }
  return { count: region.cells.length, capped: region.capped };
}
