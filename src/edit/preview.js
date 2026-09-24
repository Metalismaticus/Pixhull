// @ts-check
/**
 * The outline a tool draws before it is used.
 *
 * A brush can be 729 voxels and a fill 400 000 faces, and until now both went
 * in blind: the only tool that showed its reach was the box drag. These
 * builders turn "what the tool would touch" into a LINES vertex list the
 * renderer uploads as it stands, so the promise and the edit are made of the
 * same coordinates.
 *
 * Everything here is pure arithmetic on voxel coordinates - no GL, no DOM - so
 * the shapes can be measured in Node instead of squinted at on screen.
 */

import { DIRS } from '../core/volume.js';

/**
 * The 12 edges of a voxel-aligned cuboid, inclusive in voxel coordinates.
 * @param {[number, number, number]} min
 * @param {[number, number, number]} max
 * @returns {Float32Array} 24 vertices
 */
export function boxEdges(min, max) {
  return cuboidEdges(min[0], min[1], min[2], max[0] + 1, max[1] + 1, max[2] + 1);
}

/**
 * @param {number} x0 @param {number} y0 @param {number} z0
 * @param {number} x1 @param {number} y1 @param {number} z1
 * @returns {Float32Array}
 */
function cuboidEdges(x0, y0, z0, x1, y1, z1) {
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const data = new Float32Array(edges.length * 3);
  edges.forEach((ci, i) => data.set(c[ci], i * 3));
  return data;
}

/**
 * The plane and the two in-plane axes of one face of a voxel.
 * @param {number} x @param {number} y @param {number} z @param {number} dir
 */
function facePlane(x, y, z, dir) {
  const axis = dir >> 1;
  const base = [x, y, z];
  // Even directions point along +axis, so their face sits one step further on.
  const plane = base[axis] + (dir % 2 === 0 ? 1 : 0);
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  return { axis, plane, u, v, base };
}

/**
 * The four edges of one voxel face.
 * @param {number} x @param {number} y @param {number} z
 * @param {number} dir 0..5
 * @returns {Float32Array} 8 vertices
 */
export function faceEdges(x, y, z, dir) {
  const { axis, plane, u, v, base } = facePlane(x, y, z, dir);
  /** @param {number} du @param {number} dv @returns {[number, number, number]} */
  const corner = (du, dv) => {
    const p = /** @type {[number, number, number]} */ ([0, 0, 0]);
    p[axis] = plane;
    p[u] = base[u] + du;
    p[v] = base[v] + dv;
    return p;
  };
  const a = corner(0, 0), b = corner(1, 0), c = corner(1, 1), d = corner(0, 1);
  const data = new Float32Array(24);
  [a, b, b, c, c, d, d, a].forEach((p, i) => data.set(p, i * 3));
  return data;
}

/**
 * The border of a set of coplanar-facing faces: every edge that belongs to
 * exactly one face of the set.
 *
 * Drawing all four edges of every face instead would be a thicket of lines on
 * any surface larger than a few voxels - the one thing the user needs to see
 * is where the fill stops. Interior edges are shared by two faces, so they
 * cancel; a staircase's faces are not coplanar but still share edges, and
 * those cancel too, which is what makes a stepped surface read as one region.
 *
 * @param {Array<[number, number, number]>} cells voxels whose `dir` face is in the region
 * @param {number} dir
 * @param {[number, number, number]} dims grid size, for packing the edge key
 * @returns {Float32Array} 2 vertices per surviving edge
 */
export function regionOutline(cells, dir, dims) {
  const { axis, u, v } = facePlane(0, 0, 0, dir);
  const span = [dims[0] + 2, dims[1] + 2, dims[2] + 2];
  /** @type {Map<number, [number, number, number, number, number, number]>} */
  const edges = new Map();

  /**
   * Toggle one edge, identified by its lower endpoint and the axis it runs
   * along. Seeing it a second time means it is interior, so it goes away.
   * @param {[number, number, number]} p lower endpoint, in corner coordinates
   * @param {number} along axis the edge runs along
   */
  const toggle = (p, along) => {
    const key = ((p[0] * span[1] + p[1]) * span[2] + p[2]) * 3 + along;
    if (edges.has(key)) {
      edges.delete(key);
      return;
    }
    const q = /** @type {[number, number, number]} */ ([p[0], p[1], p[2]]);
    q[along] += 1;
    edges.set(key, [p[0], p[1], p[2], q[0], q[1], q[2]]);
  };

  for (const cell of cells) {
    const base = [cell[0], cell[1], cell[2]];
    const plane = base[axis] + (dir % 2 === 0 ? 1 : 0);
    /** @param {number} du @param {number} dv @returns {[number, number, number]} */
    const corner = (du, dv) => {
      const p = /** @type {[number, number, number]} */ ([0, 0, 0]);
      p[axis] = plane;
      p[u] = base[u] + du;
      p[v] = base[v] + dv;
      return p;
    };
    toggle(corner(0, 0), u);
    toggle(corner(0, 1), u);
    toggle(corner(0, 0), v);
    toggle(corner(1, 0), v);
  }

  const out = new Float32Array(edges.size * 6);
  let i = 0;
  for (const e of edges.values()) {
    out.set(e, i);
    i += 6;
  }
  return out;
}

/**
 * The cube of voxels a brush of radius `r` covers, clamped to the grid.
 * @param {{x: number, y: number, z: number}} c
 * @param {number} r
 * @param {[number, number, number]} dims
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function brushExtent(c, r, dims) {
  const p = [c.x, c.y, c.z];
  const min = /** @type {[number, number, number]} */ ([0, 0, 0]);
  const max = /** @type {[number, number, number]} */ ([0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    min[i] = Math.max(0, p[i] - r);
    max[i] = Math.min(dims[i] - 1, p[i] + r);
  }
  return { min, max };
}

/**
 * Where an Add brush would actually land: one voxel out along the face's
 * normal, which is the difference between promising and lying.
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @returns {{x: number, y: number, z: number}}
 */
export function addSeed(hit) {
  const n = DIRS[hit.face];
  return { x: hit.x + n[0], y: hit.y + n[1], z: hit.z + n[2] };
}

/**
 * How far either side of the cursor the cell grid reaches, in cells.
 *
 * 16 gives a 33x33 patch: 68 segments, 136 vertices, cheap enough to rebuild
 * whenever the cell under the cursor changes. Drawing the grid over the whole
 * volume is what this replaces - on 256 cubed that would be some two hundred
 * thousand lines, and at any zoom that fits the model on screen a cell is
 * finer than a pixel.
 */
export const GRID_RADIUS = 16;

/**
 * A patch of cell lines lying in the plane of one face.
 *
 * The plane is nudged `lift` outwards along the face normal so the lines do
 * not fight the surface they describe for the depth buffer; without it the
 * grid flickers in and out as the camera turns.
 *
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {[number, number, number]} dims
 * @param {number} [radius]
 * @param {number} [lift]
 * @returns {Float32Array} 2 vertices per line
 */
export function cellGrid(hit, dims, radius = GRID_RADIUS, lift = 0.02) {
  const { axis, plane, u, v, base } = facePlane(hit.x, hit.y, hit.z, hit.face);
  const n = DIRS[hit.face];
  const at = plane + n[axis] * lift;

  const u0 = Math.max(0, base[u] - radius);
  const u1 = Math.min(dims[u], base[u] + radius + 1);
  const v0 = Math.max(0, base[v] - radius);
  const v1 = Math.min(dims[v], base[v] + radius + 1);
  if (u1 <= u0 || v1 <= v0) return new Float32Array(0);

  const lines = (u1 - u0 + 1) + (v1 - v0 + 1);
  const out = new Float32Array(lines * 6);
  let i = 0;
  /** @param {number} a @param {number} b @param {number} c @param {number} d */
  const push = (a, b, c, d) => {
    const p = [0, 0, 0];
    p[axis] = at;
    p[u] = a; p[v] = b;
    out.set(p, i); i += 3;
    p[u] = c; p[v] = d;
    out.set(p, i); i += 3;
  };
  for (let a = u0; a <= u1; a++) push(a, v0, a, v1);
  for (let b = v0; b <= v1; b++) push(u0, b, u1, b);
  return out;
}

/**
 * The two diagonals of one face of a cuboid.
 *
 * How an armed face says it is armed. A second colour would be the plain way
 * to mark it and is not available: the line painter takes one colour per call,
 * and a second accent on screen is forbidden (`docs/DESIGN.md`, section 2).
 *
 * @param {[number, number, number]} min
 * @param {[number, number, number]} max inclusive, in voxel coordinates
 * @param {number} face
 * @returns {Float32Array} 4 vertices
 */
export function faceDiagonals(min, max, face) {
  const axis = face >> 1;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const at = face % 2 === 0 ? max[axis] + 1 : min[axis];
  /** @param {number} du @param {number} dv @returns {number[]} */
  const corner = (du, dv) => {
    const p = [0, 0, 0];
    p[axis] = at;
    p[u] = du ? max[u] + 1 : min[u];
    p[v] = dv ? max[v] + 1 : min[v];
    return p;
  };
  const out = new Float32Array(12);
  [corner(0, 0), corner(1, 1), corner(1, 0), corner(0, 1)].forEach((p, i) => out.set(p, i * 3));
  return out;
}

/**
 * Join several vertex lists into the one buffer the renderer draws.
 * @param {Float32Array[]} parts
 * @returns {Float32Array}
 */
export function joinLines(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
