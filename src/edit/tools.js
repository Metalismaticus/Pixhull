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

export const TOOLS = /** @type {const} */ (['paint', 'fill', 'erase', 'add', 'pick']);

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
 * @returns {{changed: boolean, picked?: number}}
 */
export function applyTool(vol, hit, opts) {
  if (opts.tool === 'pick') {
    return { changed: false, picked: vol.getFace(hit.x, hit.y, hit.z, hit.face) };
  }

  const targets = opts.symmetryX ? [hit, mirrorX(vol, hit)] : [hit];
  let changed = false;
  for (const target of targets) {
    changed = runOne(vol, target, opts) || changed;
  }
  return { changed };
}

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 */
function mirrorX(vol, hit) {
  // A face pointing +X becomes one pointing -X on the far side, and vice versa.
  const face = hit.face === 0 ? 1 : hit.face === 1 ? 0 : hit.face;
  return { x: vol.nx - 1 - hit.x, y: hit.y, z: hit.z, face };
}

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {ToolOptions} opts
 * @returns {boolean}
 */
function runOne(vol, hit, opts) {
  const h = opts.history;
  const r = Math.max(0, Math.round(opts.brush ?? 0));

  if (opts.tool === 'paint') {
    if (opts.faceOnly && r === 0) {
      if (!vol.get(hit.x, hit.y, hit.z)) return false;
      if (vol.getFace(hit.x, hit.y, hit.z, hit.face) === opts.color) return false;
      h?.touch(vol, hit.x, hit.y, hit.z);
      vol.setFace(hit.x, hit.y, hit.z, hit.face, opts.color);
      return true;
    }
    let changed = false;
    forEachInBrush(vol, hit, r, (x, y, z) => {
      if (!vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      if (opts.faceOnly) vol.setFace(x, y, z, hit.face, opts.color);
      else vol.setAllFaces(x, y, z, opts.color);
      changed = true;
    });
    return changed;
  }

  if (opts.tool === 'erase') {
    let changed = false;
    forEachInBrush(vol, hit, r, (x, y, z) => {
      if (!vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      for (let d = 0; d < 6; d++) h?.touch(vol, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      vol.set(x, y, z, false);
      changed = true;
    });
    if (changed) healAround(vol, hit, r + 1, opts.color, h);
    return changed;
  }

  if (opts.tool === 'add') {
    const n = DIRS[hit.face];
    const seed = { x: hit.x + n[0], y: hit.y + n[1], z: hit.z + n[2], face: hit.face };
    let changed = false;
    forEachInBrush(vol, seed, r, (x, y, z) => {
      if (vol.get(x, y, z)) return;
      h?.touch(vol, x, y, z);
      for (let d = 0; d < 6; d++) h?.touch(vol, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      vol.set(x, y, z, true);
      vol.setAllFaces(x, y, z, opts.color);
      changed = true;
    });
    if (changed) healAround(vol, seed, r + 1, opts.color, h);
    return changed;
  }

  if (opts.tool === 'fill') {
    return fillSurface(vol, hit, opts.color, h);
  }

  return false;
}

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
const FILL_LIMIT = 400000;

/**
 * Bucket fill across the visible surface: spreads to faces of the same colour
 * and the same facing that are connected by sight, following staircases up and
 * down rather than stopping at the edge of a flat plane.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {number} color
 * @param {import('./history.js').History} [h]
 * @returns {boolean}
 */
function fillSurface(vol, hit, color, h) {
  const face = hit.face;
  const target = vol.getFace(hit.x, hit.y, hit.z, face);
  if (target === color || !vol.get(hit.x, hit.y, hit.z)) return false;

  const n = DIRS[face];
  // The four directions lying in the face's plane.
  const perp = [];
  for (let d = 0; d < 6; d++) {
    if ((d >> 1) !== (face >> 1)) perp.push(DIRS[d]);
  }

  const key = (x, y, z) => x + vol.nx * (y + vol.ny * z);
  const seen = new Set([key(hit.x, hit.y, hit.z)]);
  const queue = [[hit.x, hit.y, hit.z]];
  let changed = false;

  for (let head = 0; head < queue.length && seen.size < FILL_LIMIT; head++) {
    const [x, y, z] = queue[head];
    h?.touch(vol, x, y, z);
    vol.setFace(x, y, z, face, color);
    changed = true;

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

  return changed;
}
