// @ts-check
/**
 * MagicaVoxel `.vox` export.
 *
 * The awkward part is not the container, it is the colour model: a `.vox`
 * voxel carries **one** colour, and a Pixhull voxel carries six, one per face.
 * Something has to be thrown away, and which something matters.
 *
 * Which something is not decided here: `voxelColor` in `voxelcolor.js` is the
 * one rule every flattening export obeys, so that a model does not look like
 * two different models depending on which button was pressed. A `.vox` cube is
 * seen from every side, so this export names no facing direction and takes the
 * rule's vote among the faces you can actually see.
 *
 * The 256-entry palette is a happy accident: Pixhull's indexed palette is the
 * same size, so colours survive the trip exactly, with no requantisation.
 */

import { voxelColor } from './voxelcolor.js';

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
    const c = voxelColor(volume, x, y, z, { fallback });
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
