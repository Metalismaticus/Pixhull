// @ts-check
/**
 * Orthographic camera, plus the angle maths that decides whether a sprite comes
 * out crisp or comes out mush.
 *
 * The thing most 3D-to-sprite pipelines get wrong: stepping a turnaround by
 * 360/n degrees produces angles whose projected edges have irrational slopes.
 * A cube edge at 22.5 degrees cannot land on a pixel grid, so every frame needs
 * anti-aliasing to look acceptable - and anti-aliasing is exactly what makes it
 * stop reading as pixel art.
 *
 * Angles whose tangent is a small rational (0, 1/2, 1/1, 2/1, ...) project to
 * repeating pixel runs - the "2 across, 1 up" staircase every isometric artist
 * draws by hand. We generate those from the Stern-Brocot tree, which produces
 * exactly 4, 8, 16, 32 ... directions per turnaround. Counts in between get
 * uniform angles snapped to the nearest clean slope, so an artist asking for 12
 * frames gets 12 frames that still look hand-drawn.
 */

import { mat4Identity, mat4Mul, mat4Ortho, mat4RotX, mat4RotY, mat4Translate, transformPoint } from './glutil.js';

const DEG = Math.PI / 180;

/** Classic 2:1 dimetric - a cube's top face is a 2-wide, 1-tall rhombus. */
export const PITCH_ISO_2_1 = Math.atan(0.5);
/** True isometric - all three axes equally foreshortened, but jagged in pixels. */
export const PITCH_ISO_TRUE = Math.atan(1 / Math.SQRT2);

/** `key` is an i18n lookup; this module stays free of UI strings. */
export const PITCH_PRESETS = [
  { id: 'iso21', key: 'pitch.iso21', pitch: PITCH_ISO_2_1 },
  { id: 'isoTrue', key: 'pitch.isoTrue', pitch: PITCH_ISO_TRUE },
  { id: 'deg30', key: 'pitch.deg30', pitch: 30 * DEG },
  { id: 'deg45', key: 'pitch.deg45', pitch: 45 * DEG },
  { id: 'deg60', key: 'pitch.deg60', pitch: 60 * DEG },
  { id: 'top', key: 'pitch.top', pitch: 89.999 * DEG },
  { id: 'side', key: 'pitch.side', pitch: 0 },
];

/**
 * Slopes from one level of the Stern-Brocot tree between 0/1 and 1/0, as angles
 * in [0, 90). Level 1 -> [0], level 2 -> [0, 45], level 3 -> [0, 26.57, 45, 63.43].
 * @param {number} level
 * @returns {number[]} radians, ascending
 */
export function cleanSlopeAngles(level) {
  /** @type {Array<[number, number]>} fractions p/q, from 0/1 to 1/0 */
  let seq = [[0, 1], [1, 0]];
  for (let l = 1; l < level; l++) {
    /** @type {Array<[number, number]>} */
    const next = [seq[0]];
    for (let i = 0; i + 1 < seq.length; i++) {
      next.push([seq[i][0] + seq[i + 1][0], seq[i][1] + seq[i + 1][1]]);
      next.push(seq[i + 1]);
    }
    seq = next;
  }
  // Drop the trailing 1/0: it is 90 degrees, which belongs to the next quadrant.
  return seq.slice(0, -1).map(([p, q]) => Math.atan2(p, q));
}

/**
 * Yaw angles for an n-direction turnaround.
 * @param {number} n how many directions
 * @param {'clean'|'uniform'} mode
 * @returns {number[]} radians, ascending from 0
 */
export function directionYaws(n, mode = 'clean') {
  if (n < 1) return [0];
  if (mode === 'uniform') {
    return Array.from({ length: n }, (_, i) => (i * 2 * Math.PI) / n);
  }

  const perQuadrant = n / 4;
  const level = Math.log2(perQuadrant) + 1;
  if (Number.isInteger(level) && level >= 1) {
    const q = cleanSlopeAngles(level);
    const out = [];
    for (let k = 0; k < 4; k++) for (const a of q) out.push(k * (Math.PI / 2) + a);
    return out;
  }

  // Not a clean count: snap uniform angles onto a dense clean set.
  const dense = [];
  for (const a of cleanSlopeAngles(5)) for (let k = 0; k < 4; k++) dense.push(k * (Math.PI / 2) + a);
  dense.sort((a, b) => a - b);

  const seen = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    const want = (i * 2 * Math.PI) / n;
    let best = dense[0];
    let bestD = Infinity;
    for (const a of dense) {
      const d = Math.abs(a - want);
      if (d < bestD) { bestD = d; best = a; }
    }
    const key = best.toFixed(6);
    // Two requested frames landing on the same clean angle would be duplicates;
    // keep the exact angle for the second one rather than shipping a copy.
    out.push(seen.has(key) ? want : best);
    seen.add(key);
  }
  return out;
}

export class OrthoCamera {
  constructor() {
    this.yaw = 45 * DEG;
    this.pitch = PITCH_ISO_2_1;
    /** Screen pixels per voxel. Kept integral for crisp output. */
    this.pixelsPerVoxel = 4;
    /** @type {[number, number, number]} */
    this.target = [0, 0, 0];
    /** Extra screen-space pan, in pixels. */
    this.panX = 0;
    this.panY = 0;
    this._view = new Float32Array(16);
    this._proj = new Float32Array(16);
    this._vp = new Float32Array(16);
  }

  /** @param {[number,number,number]} center */
  lookAtCenter(center) {
    this.target = center;
  }

  /** World -> view. */
  viewMatrix() {
    const t = mat4Translate(-this.target[0], -this.target[1], -this.target[2]);
    const ry = mat4RotY(-this.yaw);
    const rx = mat4RotX(-this.pitch);
    return mat4Mul(rx, mat4Mul(ry, t), this._view);
  }

  /**
   * Projection sized so one voxel is exactly `pixelsPerVoxel` device pixels
   * along the screen axes.
   * @param {number} vw viewport width in device pixels
   * @param {number} vh viewport height in device pixels
   * @param {number} depth how far the near/far planes sit from the target
   */
  projMatrix(vw, vh, depth = 4096) {
    const hw = vw / (2 * this.pixelsPerVoxel);
    const hh = vh / (2 * this.pixelsPerVoxel);
    const ox = this.panX / this.pixelsPerVoxel;
    const oy = this.panY / this.pixelsPerVoxel;
    return mat4Ortho(-hw - ox, hw - ox, -hh - oy, hh - oy, -depth, depth, this._proj);
  }

  /** @returns {Float32Array} */
  viewProj(vw, vh, depth) {
    return mat4Mul(this.projMatrix(vw, vh, depth), this.viewMatrix(), this._vp);
  }

  /**
   * Screen-space extent of an axis-aligned box under the current rotation.
   * Used to size sprite exports so nothing clips and nothing wobbles between
   * frames.
   * @param {{min:[number,number,number], max:[number,number,number]}} box
   * @returns {{w: number, h: number, cx: number, cy: number}} in voxel units
   */
  projectedExtent(box) {
    const view = this.viewMatrix();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = transformPoint(
        view,
        i & 1 ? box.max[0] + 1 : box.min[0],
        i & 2 ? box.max[1] + 1 : box.min[1],
        i & 4 ? box.max[2] + 1 : box.min[2]
      );
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  /** Frame a box in the viewport, snapping the zoom to an integer scale. */
  fit(box, vw, vh, margin = 0.9) {
    this.target = [
      (box.min[0] + box.max[0] + 1) / 2,
      (box.min[1] + box.max[1] + 1) / 2,
      (box.min[2] + box.max[2] + 1) / 2,
    ];
    this.panX = 0;
    this.panY = 0;
    // projectedExtent is in voxel units and independent of zoom, so the ratio
    // to the viewport is directly the pixels-per-voxel we can afford.
    const e = this.projectedExtent(box);
    const scale = Math.min((vw * margin) / Math.max(e.w, 1), (vh * margin) / Math.max(e.h, 1));
    this.pixelsPerVoxel = Math.max(1, Math.floor(scale));
  }
}

export { DEG };
