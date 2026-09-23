// @ts-check
/**
 * MagicaVoxel `.vox` export.
 *
 * The awkward part is not the container, it is the colour model: a `.vox`
 * voxel carries **one** colour, and a Pixhull voxel carries six, one per face.
 * Something has to be thrown away, and which something matters.
 *
 * The rule here is a vote among the faces you can actually see. A tyre whose
 * visible faces are all black stays black even if a buried face is not; a body
 * panel takes the panel's colour rather than whatever happens to be on its
 * underside. Faces that no one can see get no vote, because keeping them would
 * let hidden geometry decide how the model looks.
 *
 * The 256-entry palette is a happy accident: Pixhull's indexed palette is the
 * same size, so colours survive the trip exactly, with no requantisation.
 */

import { DIRS } from '../core/volume.js';

/** MagicaVoxel refuses anything larger along any axis. */
export const VOX_MAX_SIZE = 256;

class VoxWriter {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.n = 0;
  }
  _room(k) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.n + k) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  u8(v) {
    this._room(1);
    this.buf[this.n++] = v & 255;
  }
  i32(v) {
    this._room(4);
    this.buf[this.n++] = v & 255;
    this.buf[this.n++] = (v >>> 8) & 255;
    this.buf[this.n++] = (v >>> 16) & 255;
    this.buf[this.n++] = (v >>> 24) & 255;
  }
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes() {
    return this.buf.subarray(0, this.n);
  }
}

/**
 * @param {string} id
 * @param {Uint8Array} content
 * @returns {Uint8Array} a chunk with no children
 */
function chunk(id, content) {
  const w = new VoxWriter();
  w.ascii(id);
  w.i32(content.length);
  w.i32(0);
  w._room(content.length);
  w.buf.set(content, w.n);
  w.n += content.length;
  return w.bytes();
}

/**
 * The colour to give a voxel that has six of them: the most common among its
 * exposed faces.
 * @param {import('../core/volume.js').Volume} vol
 * @param {number} fallback
 * @returns {number} palette index 1..255
 */
function voteColor(vol, x, y, z, fallback) {
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
  // Fully enclosed voxels have no visible face at all; they still have to be
  // written, so fall back to any colour they carry, then to the model's.
  return best || any || fallback;
}

/**
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../core/palette.js').Palette} palette
 * @returns {{bytes: Uint8Array, stats: {voxels: number, colors: number, size: [number, number, number]}}}
 */
export function exportVox(volume, palette) {
  const box = volume.bounds();
  if (!box) throw new Error('Nothing to export: the model is empty.');

  // Crop to the model rather than the grid, so a small model in a large grid
  // does not arrive in MagicaVoxel surrounded by empty space.
  const sx = box.max[0] - box.min[0] + 1;
  const sy = box.max[1] - box.min[1] + 1;
  const sz = box.max[2] - box.min[2] + 1;
  if (sx > VOX_MAX_SIZE || sy > VOX_MAX_SIZE || sz > VOX_MAX_SIZE) {
    throw new Error('MagicaVoxel caps a model at ' + VOX_MAX_SIZE + ' voxels per axis.');
  }

  const fallback = palette.size > 1 ? 1 : 1;

  const xyzi = new VoxWriter();
  let count = 0;
  const used = new Set();
  volume.forEachSolid((x, y, z) => {
    const c = voteColor(volume, x, y, z, fallback);
    used.add(c);
    // MagicaVoxel is Z-up; Pixhull is Y-up.
    xyzi.u8(x - box.min[0]);
    xyzi.u8(z - box.min[2]);
    xyzi.u8(y - box.min[1]);
    xyzi.u8(c);
    count++;
  });

  const size = new VoxWriter();
  size.i32(sx);
  size.i32(sz);
  size.i32(sy);

  const countPrefix = new VoxWriter();
  countPrefix.i32(count);
  const xyziContent = new Uint8Array(4 + xyzi.n);
  xyziContent.set(countPrefix.bytes(), 0);
  xyziContent.set(xyzi.bytes(), 4);

  // The spec is explicit and easy to get wrong: palette index i is stored at
  // RGBA[i - 1], so the array is shifted by one relative to the indices used
  // in XYZI.
  const rgba = new Uint8Array(1024);
  for (let i = 1; i < 256; i++) {
    const o = (i - 1) * 4;
    if (i < palette.size) {
      const [r, g, b] = palette.rgb(i);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    } else {
      rgba[o + 3] = 255; // opaque placeholder; MagicaVoxel dislikes a zero alpha
    }
  }

  const children = [
    chunk('SIZE', size.bytes()),
    chunk('XYZI', xyziContent),
    chunk('RGBA', rgba),
  ];
  const childrenSize = children.reduce((n, c) => n + c.length, 0);

  const out = new VoxWriter();
  out.ascii('VOX ');
  out.i32(150);
  out.ascii('MAIN');
  out.i32(0);
  out.i32(childrenSize);
  for (const c of children) {
    out._room(c.length);
    out.buf.set(c, out.n);
    out.n += c.length;
  }

  return {
    bytes: out.bytes().slice(),
    stats: { voxels: count, colors: used.size, size: [sx, sy, sz] },
  };
}
