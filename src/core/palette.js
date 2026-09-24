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

/**
 * How close two entries have to be before they count as the same colour.
 *
 * Chosen here, not by the owner: half of the just-noticeable difference this
 * project uses elsewhere (ΔE 2, `tests/palette/accuracy.mjs`). One JND is what
 * a *single* pair can be apart without anyone seeing it; merging several pairs
 * across a gradient adds up, and half a JND per step leaves room for that.
 *
 * Measured on the owner's lorry (45 709 art colours quantised to 255 slots),
 * how many of the 255 a merge hands back: 65 at ΔE 0.5, 136 at 1.0, 174 at 2.0,
 * 193 at 3.0. Even the cautious end frees dozens of slots, so there was no
 * reason to reach for the aggressive one.
 */
export const MERGE_DELTA_E = 1.0;

export class Palette {
  constructor() {
    /** @type {number[]} packed 0xRRGGBB, slot 0 is the reserved empty entry */
    this.colors = [0x000000];
    /** @type {Map<number, number>} packed colour -> index */
    this.lookup = new Map();
    /** true once art brought in more than 255 distinct colours */
    this.overflowed = false;
    /**
     * Slots that exist but hold no colour, because a merge freed them.
     *
     * A freed slot is not removed: renumbering is forbidden, so the array keeps
     * its length and the hole is remembered here instead. `add()` fills the
     * lowest hole before growing, which is the whole point - a full palette
     * stops being a dead end.
     * @type {Set<number>}
     */
    this.free = new Set();
    /** @type {Float64Array|null} Lab cache for `nearest`, rebuilt on change */
    this._labs = null;
    /** @type {number} palette length the Lab cache was built for */
    this._labsFor = -1;
  }

  get size() {
    return this.colors.length;
  }

  /** How many slots actually hold a colour (slot 0 and freed slots aside). */
  get live() {
    return this.colors.length - 1 - this.free.size;
  }

  /** No slot left to take a new colour: at the cap and nothing freed. */
  get full() {
    return this.free.size === 0 && this.colors.length >= PALETTE_MAX;
  }

  /** @param {number} i @returns {boolean} slot i holds a colour */
  has(i) {
    return Number.isInteger(i) && i >= 1 && i < this.colors.length && !this.free.has(i);
  }

  /** Every slot that holds a colour, in index order. @returns {number[]} */
  slots() {
    const out = [];
    for (let i = 1; i < this.colors.length; i++) if (!this.free.has(i)) out.push(i);
    return out;
  }

  /**
   * Drop the Lab cache. Mandatory after any change that keeps the palette's
   * length - the cache cannot notice those on its own.
   */
  _dropLabs() {
    this._labs = null;
    this._labsFor = -1;
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
    if (hit !== undefined && this.has(hit)) return hit;
    // A slot a merge freed takes the colour before the palette grows, so the
    // hole is reused rather than left behind while the cap stays in the way.
    if (this.free.size > 0) {
      let i = PALETTE_MAX;
      for (const f of this.free) if (f < i) i = f;
      this.free.delete(i);
      this.colors[i] = key;
      this.lookup.set(key, i);
      this._dropLabs();
      return i;
    }
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
      // A freed slot holds no colour; matching against it would answer with
      // black for every pixel the merge made a hole for.
      if (this.free.has(i)) continue;
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
    this._dropLabs();
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
    this._dropLabs();
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

  /**
   * Which slots hold colours close enough to be one colour.
   *
   * Nothing is changed here: a plan is data, so the caller can ask "would this
   * free anything?" to light a button without touching the model, and then
   * apply the very same map to the face bytes and to the palette.
   *
   * Grouping is one pass, keeper-first, deliberately not single linkage: with
   * chaining a smooth ramp of fifty shades would collapse into one colour,
   * because each neighbour is within the threshold of the last. Here every
   * merged slot is within the threshold of the slot it merges *into*, so no
   * face ever moves further than `threshold` from the colour it had.
   *
   * Which slot survives is decided by `weights` when the caller has them - the
   * colour painting more of the model keeps its index, so the bigger surface is
   * the one that does not change at all.
   *
   * @param {number} [threshold] CIEDE2000 distance, `MERGE_DELTA_E` by default
   * @param {Uint32Array|number[]} [weights] how many faces each slot paints
   * @returns {{remap: Uint8Array, freed: number[], groups: number, worst: number}}
   */
  planMerge(threshold = MERGE_DELTA_E, weights) {
    const remap = new Uint8Array(PALETTE_MAX);
    for (let i = 0; i < PALETTE_MAX; i++) remap[i] = i;
    const freed = [];
    let groups = 0;
    let worst = 0;

    const lab = this.labs();
    const order = this.slots();
    // Heavier first, so the keeper is the colour with more of the model on it;
    // ties fall back to the lower index, which keeps the result the same on
    // every run.
    if (weights) order.sort((a, b) => ((weights[b] | 0) - (weights[a] | 0)) || (a - b));

    for (const k of order) {
      if (remap[k] !== k) continue;
      let merged = 0;
      for (const j of order) {
        if (j === k || remap[j] !== j) continue;
        const d = ciede2000(
          lab[k * 3], lab[k * 3 + 1], lab[k * 3 + 2],
          lab[j * 3], lab[j * 3 + 1], lab[j * 3 + 2],
        );
        if (d > threshold) continue;
        remap[j] = k;
        freed.push(j);
        merged++;
        if (d > worst) worst = d;
      }
      if (merged > 0) groups++;
    }

    freed.sort((a, b) => a - b);
    return { remap, freed, groups, worst };
  }

  /**
   * Carry out a plan on the palette side: free the merged slots and send every
   * colour that named one to the slot that survived.
   *
   * The caller has to rewrite the face bytes with the same `remap` (see
   * `Volume.remapFaces`). Order does not matter, but doing only one of the two
   * leaves faces pointing at a hole, which the renderer draws as transparent.
   *
   * @param {{remap: Uint8Array, freed: number[]}} plan
   * @returns {number} how many slots were freed
   */
  applyMerge(plan) {
    if (plan.freed.length === 0) return 0;
    const gone = new Set(plan.freed);
    // Every source colour aliased onto a merged slot follows it. Dropping the
    // aliases instead would send the eyedropper and the next `add()` through a
    // nearest search that can answer differently.
    for (const [key, index] of this.lookup) {
      if (gone.has(index)) this.lookup.set(key, plan.remap[index]);
    }
    for (const i of plan.freed) {
      this.colors[i] = 0x000000;
      this.free.add(i);
    }
    this._dropLabs();
    return plan.freed.length;
  }

  /**
   * Overwrite this palette with a snapshot, in place.
   *
   * In place because the renderer, the editor and the history all hold this
   * object; swapping in a new instance would leave them pointing at the palette
   * the model no longer uses.
   * @param {{colors: number[], aliases: Int32Array, overflowed: boolean, free?: Int32Array|number[]}} s
   */
  restore(s) {
    this.colors = s.colors.slice();
    this.lookup = new Map();
    for (let i = 0; i < s.aliases.length; i += 2) this.lookup.set(s.aliases[i], s.aliases[i + 1]);
    this.free = new Set(s.free ?? []);
    this.overflowed = s.overflowed;
    this._dropLabs();
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
      // A freed slot stays transparent for the same reason slot 0 does: a face
      // still pointing at it is a bug, and a bug should be visible.
      if (this.free.has(i)) continue;
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
   * @returns {{colors: number[], aliases: Int32Array, overflowed: boolean, free: Int32Array}}
   */
  snapshot() {
    const aliases = new Int32Array(this.lookup.size * 2);
    let i = 0;
    for (const [key, index] of this.lookup) {
      aliases[i++] = key;
      aliases[i++] = index;
    }
    return {
      colors: this.colors.slice(),
      aliases,
      overflowed: this.overflowed,
      free: Int32Array.from(this.free),
    };
  }

  /**
   * @param {{colors: number[], aliases: Int32Array, overflowed: boolean, free?: Int32Array|number[]}} s
   * @returns {Palette}
   */
  static fromSnapshot(s) {
    const p = new Palette();
    p.restore(s);
    return p;
  }

  /**
   * The saved project's palette: the colours, plus which slots are holes.
   *
   * The holes have to be saved. Without them a reopened project shows a black
   * swatch where a merge left a gap, and the next colour added grows the
   * palette instead of filling the hole.
   * @returns {{colors: number[], free?: number[]}}
   */
  serialize() {
    const out = /** @type {{colors: number[], free?: number[]}} */ ({ colors: this.colors.slice() });
    if (this.free.size > 0) out.free = [...this.free].sort((a, b) => a - b);
    return out;
  }

  /** @param {{colors: number[], free?: number[]}} data @returns {Palette} */
  static deserialize(data) {
    const p = new Palette();
    p.colors = data.colors.slice();
    p.free = new Set(data.free ?? []);
    p.lookup = new Map();
    for (let i = 1; i < p.colors.length; i++) if (!p.free.has(i)) p.lookup.set(p.colors[i], i);
    return p;
  }
}
