// @ts-check
/**
 * Indexed palette. Pixel art lives in small palettes, so we lean into it:
 * a voxel face stores a single byte, and the model can never contain a colour
 * that was not in the source art. That is what keeps exports on-palette.
 *
 * Index 0 is reserved and means "no colour assigned".
 */

import { packedToLab, ciede2000 } from './color.js';

export const PALETTE_MAX = 256;

export class Palette {
  constructor() {
    /** @type {number[]} packed 0xRRGGBB, slot 0 is the reserved empty entry */
    this.colors = [0x000000];
    /** @type {Map<number, number>} packed colour -> index */
    this.lookup = new Map();
    /** true once art brought in more than 255 distinct colours */
    this.overflowed = false;
    /** @type {Float64Array|null} Lab cache for `nearest`, rebuilt on change */
    this._labs = null;
    /** @type {number} palette length the Lab cache was built for */
    this._labsFor = -1;
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
   * Closest palette entry by CIEDE2000.
   *
   * This used to be redmean, a weighted RGB distance. Redmean is cheaper but
   * not perceptual, and it is the reason a red cab could resolve to a grey:
   * in RGB a saturated colour sits no further from a light neutral than two
   * neighbouring neutrals sit from each other. See `color.js`.
   *
   * @param {number} r @param {number} g @param {number} b
   * @returns {number} index in 1..255 (0 only when the palette is empty)
   */
  nearest(r, g, b) {
    const lab = this.labs();
    const [L, A, B] = packedToLab(((r & 255) << 16) | ((g & 255) << 8) | (b & 255));
    let best = 0;
    let bestD = Infinity;
    for (let i = 1; i < this.colors.length; i++) {
      const o = i * 3;
      const d = ciede2000(L, A, B, lab[o], lab[o + 1], lab[o + 2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Lab for every entry, built once and kept until the colours change. Without
   * it a sprite sheet would reconvert all 255 entries for every pixel.
   *
   * The cache notices a palette that grew. Anything that ever changes a colour
   * *in place* has to clear `_labs` itself.
   * @returns {Float64Array}
   */
  labs() {
    if (this._labs && this._labsFor === this.colors.length) return this._labs;
    const out = new Float64Array(this.colors.length * 3);
    for (let i = 1; i < this.colors.length; i++) {
      const [L, A, B] = packedToLab(this.colors[i]);
      out[i * 3] = L;
      out[i * 3 + 1] = A;
      out[i * 3 + 2] = B;
    }
    this._labs = out;
    this._labsFor = this.colors.length;
    return out;
  }

  /**
   * Install a chosen set of colours together with the mapping that put them
   * there, for art that brought in more than 255 distinct colours.
   *
   * The mapping is the point: every colour the art actually contains is
   * already resolved, so the import never pays a nearest-colour search, and it
   * resolves to the entry the quantiser grouped it with rather than to whatever
   * happened to be interned first.
   *
   * @param {number[]} colors packed 0xRRGGBB, at most PALETTE_MAX - 1 of them
   * @param {Map<number, number>} assign source colour -> index into `colors`
   */
  adopt(colors, assign) {
    if (this.colors.length !== 1) throw new Error('adopt() needs an empty palette');
    this.colors = [0x000000, ...colors.slice(0, PALETTE_MAX - 1)];
    this.lookup = new Map();
    for (let i = 1; i < this.colors.length; i++) this.lookup.set(this.colors[i], i);
    for (const [key, slot] of assign) {
      if (slot + 1 < this.colors.length) this.lookup.set(key, slot + 1);
    }
    this.overflowed = true;
    this._labs = null;
  }

  /**
   * Recolour one slot in place, keeping its index.
   *
   * This is the whole point of an indexed model: a face stores a byte, so
   * changing what that byte *means* recolours the model without touching a
   * single voxel - one 1 KB texture upload, the same cost at 32 as at 512.
   * Renumbering indices would do the opposite and turn every stored byte,
   * including every one sitting in the undo history, into a lie.
   *
   * The lookup table is the only thing that needs care. The old colour's key
   * is dropped only when this index is the one that owns it, so a duplicate
   * colour elsewhere in the palette keeps answering for it; the new key is
   * installed only when nobody owns it yet, so an existing slot of that colour
   * stays the canonical home and `add()` keeps returning one index per colour.
   *
   * Source colours that a quantised import aliased onto this slot stay aliased:
   * they name the material, and the material is what just changed.
   *
   * @param {number} i index in 1..size-1
   * @param {number} r 0..255 @param {number} g 0..255 @param {number} b 0..255
   * @returns {boolean} true when the slot actually changed
   */
  replace(i, r, g, b) {
    if (!Number.isInteger(i) || i < 1 || i >= this.colors.length) return false;
    const key = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
    const old = this.colors[i] | 0;
    if (old === key) return false;
    if (this.lookup.get(old) === i) this.lookup.delete(old);
    this.colors[i] = key;
    if (!this.lookup.has(key)) this.lookup.set(key, i);
    // The Lab cache is keyed by palette *length*, which did not change here.
    // Dropping it is mandatory, not tidiness: `nearest()` would otherwise keep
    // matching against the colour this slot used to hold.
    this._labs = null;
    this._labsFor = -1;
    return true;
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

  /**
   * The whole palette, aliases included, as plain data for `postMessage`.
   *
   * Deliberately not `serialize()`: that one keeps only the colours, because a
   * saved project reopens against its own art. A palette coming back from a
   * carve has to arrive complete - the lookup holds every source colour a
   * quantised import aliased onto a slot, and losing it would send the
   * eyedropper and the next `add()` through a nearest-colour search that can
   * answer differently from the carve that just ran.
   *
   * @returns {{colors: number[], aliases: Int32Array, overflowed: boolean}}
   */
  snapshot() {
    const aliases = new Int32Array(this.lookup.size * 2);
    let i = 0;
    for (const [key, index] of this.lookup) {
      aliases[i++] = key;
      aliases[i++] = index;
    }
    return { colors: this.colors.slice(), aliases, overflowed: this.overflowed };
  }

  /**
   * @param {{colors: number[], aliases: Int32Array, overflowed: boolean}} s
   * @returns {Palette}
   */
  static fromSnapshot(s) {
    const p = new Palette();
    p.colors = s.colors.slice();
    p.lookup = new Map();
    for (let i = 0; i < s.aliases.length; i += 2) p.lookup.set(s.aliases[i], s.aliases[i + 1]);
    p.overflowed = s.overflowed;
    return p;
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
