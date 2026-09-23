// @ts-check
/**
 * Indexed palette. Pixel art lives in small palettes, so we lean into it:
 * a voxel face stores a single byte, and the model can never contain a colour
 * that was not in the source art. That is what keeps exports on-palette.
 *
 * Index 0 is reserved and means "no colour assigned".
 */

export const PALETTE_MAX = 256;

export class Palette {
  constructor() {
    /** @type {number[]} packed 0xRRGGBB, slot 0 is the reserved empty entry */
    this.colors = [0x000000];
    /** @type {Map<number, number>} packed colour -> index */
    this.lookup = new Map();
    /** true once art brought in more than 255 distinct colours */
    this.overflowed = false;
  }

  get size() {
    return this.colors.length;
  }

  /**
   * Intern a colour, returning its palette index. Once the palette is full the
   * nearest existing colour is returned instead, so import degrades rather than
   * failing.
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @returns {number} index in 1..255
   */
  add(r, g, b) {
    const key = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
    const hit = this.lookup.get(key);
    if (hit !== undefined) return hit;
    if (this.colors.length >= PALETTE_MAX) {
      this.overflowed = true;
      // Cache the answer. Without this, art with thousands of anti-aliased
      // colours pays a 255-entry search for every *pixel* rather than for every
      // distinct colour, which is the difference between milliseconds and
      // seconds on a detailed reference sheet.
      const nearest = this.nearest(r, g, b);
      this.lookup.set(key, nearest);
      return nearest;
    }
    const i = this.colors.length;
    this.colors.push(key);
    this.lookup.set(key, i);
    return i;
  }

  /**
   * Closest palette entry by redmean distance - cheap, and noticeably better
   * than plain RGB euclidean on the saturated colours pixel art tends to use.
   * @param {number} r @param {number} g @param {number} b
   * @returns {number} index in 1..255 (0 only when the palette is empty)
   */
  nearest(r, g, b) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 1; i < this.colors.length; i++) {
      const c = this.colors[i];
      const dr = ((c >> 16) & 255) - r;
      const dg = ((c >> 8) & 255) - g;
      const db = (c & 255) - b;
      const rm = (((c >> 16) & 255) + r) * 0.5;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * @param {number} i
   * @returns {[number, number, number]}
   */
  rgb(i) {
    const c = this.colors[i] | 0;
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  }

  /** @param {number} i @returns {string} CSS hex */
  hex(i) {
    return '#' + (this.colors[i] | 0).toString(16).padStart(6, '0');
  }

  /**
   * RGBA8 data for a PALETTE_MAX x 1 lookup texture. Slot 0 is transparent so a
   * face that somehow lost its colour is visibly wrong rather than silently black.
   * @returns {Uint8Array}
   */
  toTextureData() {
    const out = new Uint8Array(PALETTE_MAX * 4);
    for (let i = 1; i < this.colors.length; i++) {
      const c = this.colors[i];
      out[i * 4 + 0] = (c >> 16) & 255;
      out[i * 4 + 1] = (c >> 8) & 255;
      out[i * 4 + 2] = c & 255;
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** @returns {{colors: number[]}} */
  serialize() {
    return { colors: this.colors.slice() };
  }

  /** @param {{colors: number[]}} data @returns {Palette} */
  static deserialize(data) {
    const p = new Palette();
    p.colors = data.colors.slice();
    p.lookup = new Map();
    for (let i = 1; i < p.colors.length; i++) p.lookup.set(p.colors[i], i);
    return p;
  }
}
