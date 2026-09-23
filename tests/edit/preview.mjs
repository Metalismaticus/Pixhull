// @ts-check
/**
 * The outline a tool promises has the shape of what the tool will do.
 *
 * This is the half of the panel that cannot be checked by reading the screen:
 * a wrong outline still looks like an outline. The numbers here are exact and
 * come from counting edges by hand, not from a run.
 *
 * Red without the fix:
 *   - make `regionOutline` emit all four edges of every face instead of
 *     cancelling shared ones: the 3x3 patch reports 24 edges instead of 12
 *     (measured), which on screen is the thicket of lines the design forbids;
 *   - drop `addSeed` from the Add outline (outline the face's own voxel): the
 *     Add case reports a cube centred one voxel short of where the voxels land;
 *   - give `brushExtent` no clamp: the brush at the grid's edge reports a cube
 *     reaching outside the grid.
 */

import { boxEdges, faceEdges, regionOutline, brushExtent, addSeed, joinLines } from '../../src/edit/preview.js';

/** @param {Float32Array} lines @returns {number} */
const edgeCount = (lines) => lines.length / 6;

export function run() {
  /** @type {string[]} */
  const bad = [];

  // A cuboid is 12 edges, whatever its size.
  if (edgeCount(boxEdges([0, 0, 0], [0, 0, 0])) !== 12) bad.push('unit box is not 12 edges');
  if (edgeCount(boxEdges([2, 3, 4], [6, 7, 8])) !== 12) bad.push('cuboid is not 12 edges');

  // One face is 4 edges, and every vertex of it sits in that face's plane.
  const face = faceEdges(5, 6, 7, 4); // +Z face of voxel (5,6,7) lies at z = 8
  if (edgeCount(face) !== 4) bad.push('face is not 4 edges');
  for (let i = 2; i < face.length; i += 3) {
    if (face[i] !== 8) { bad.push('+Z face is off its plane at z=' + face[i]); break; }
  }
  const nz = faceEdges(5, 6, 7, 5); // -Z face lies at z = 7
  if (nz[2] !== 7) bad.push('-Z face is off its plane at z=' + nz[2]);

  // A 3x3 patch of faces has a 12-edge border; the 12 interior edges are
  // shared by two faces each and must cancel.
  /** @type {Array<[number, number, number]>} */
  const patch = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) patch.push([x, y, 0]);
  const border = regionOutline(patch, 4, [8, 8, 8]);
  if (edgeCount(border) !== 12) bad.push('3x3 patch border is ' + edgeCount(border) + ' edges, want 12');

  // A single face is its own border.
  if (edgeCount(regionOutline([[0, 0, 0]], 4, [8, 8, 8])) !== 4) bad.push('one-face region is not 4 edges');

  // Two faces of a staircase are on different planes: they share no edge, so
  // nothing cancels and both borders survive.
  const steps = regionOutline([[0, 0, 0], [1, 0, 1]], 4, [8, 8, 8]);
  if (edgeCount(steps) !== 8) bad.push('staircase border is ' + edgeCount(steps) + ' edges, want 8');

  // The brush cube is (2r+1) on a side and never leaves the grid.
  const mid = brushExtent({ x: 5, y: 5, z: 5 }, 2, [16, 16, 16]);
  if (mid.min.join() !== '3,3,3' || mid.max.join() !== '7,7,7') bad.push('brush cube is ' + mid.min + '..' + mid.max);
  const corner = brushExtent({ x: 0, y: 0, z: 15 }, 2, [16, 16, 16]);
  if (corner.min.join() !== '0,0,13' || corner.max.join() !== '2,2,15') {
    bad.push('brush cube at the edge is ' + corner.min + '..' + corner.max);
  }

  // Add lays its cube one voxel out along the face's normal.
  if (JSON.stringify(addSeed({ x: 4, y: 4, z: 4, face: 4 })) !== JSON.stringify({ x: 4, y: 4, z: 5 })) {
    bad.push('add seed does not step along +Z');
  }
  if (JSON.stringify(addSeed({ x: 4, y: 4, z: 4, face: 1 })) !== JSON.stringify({ x: 3, y: 4, z: 4 })) {
    bad.push('add seed does not step along -X');
  }

  // Two outlines - the mirrored case - are one buffer.
  const joined = joinLines([boxEdges([0, 0, 0], [0, 0, 0]), boxEdges([9, 0, 0], [9, 0, 0])]);
  if (edgeCount(joined) !== 24) bad.push('mirrored pair is ' + edgeCount(joined) + ' edges, want 24');

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '12+4 edges, 3x3 border 12 of 36 drawn, brush clamped, add seed stepped'
      : bad.slice(0, 3).join('; '),
  };
}
