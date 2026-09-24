// @ts-check
/**
 * Where the six drawings disagree about one voxel's colour.
 *
 * A voxel has six independently painted faces, so two views giving it two
 * different colours is not a fault by itself - that is how the model carries
 * more than one colour per cube. It becomes information when the two colours
 * are far apart: the artist drew the headlight amber from the side and cream
 * from the front, and nothing in the tool can decide which one is meant
 * (`docs/ROADMAP.md`, "Карта расхождений"; `docs/DECISIONS.md`, 2026-09-24 -
 * disagreements are shown, not repaired).
 *
 * Nothing here touches the model. The map is a second, separate description of
 * the same voxels: its own instance buffer and its own six-colour palette. The
 * face bytes of the volume are never read for it and never written by it
 * (`CLAUDE.md`, "Байт грани - источник истины").
 *
 * The measure is CIEDE2000, the same one the palette merges on, so "dE 1 is the
 * threshold of noticing" means the same thing here as it does there.
 */

import { VIEW_GEOM, VIEW_NAMES } from './views.js';
import { ciede2000Packed } from './color.js';
import { DIRS } from './volume.js';

/**
 * Band edges in dE, loudest first. Measured, not chosen by eye
 * (`docs/specs/2026-09-24-3-disagreement-map.md`, §2 and §10.1): anti-aliasing
 * and shading inside one drawing reach 2.1-4.6 dE, so "agree" has to end at 3
 * and "slight" at 10; the truck's headlights disagree by 23.15 and 26.03, so
 * they have to land above 10, not above the prototype's 40, which missed them.
 *
 * The last band is not a distance at all: a voxel only one view ever saw has
 * nothing to compare with, which is different from agreeing.
 */
export const BANDS = [
  { key: 'view.mapBandMax', min: 50 },
  { key: 'view.mapBandHigh', min: 25 },
  { key: 'view.mapBandMid', min: 10 },
  { key: 'view.mapBandLow', min: 3 },
  { key: 'view.mapBandAgree', min: 0 },
  { key: 'view.mapBandNone', min: -Infinity },
];

/** Band index of a voxel only one view saw: "nothing to compare with". */
export const BAND_LONELY = 5;

/**
 * At and above this the disagreement is counted in the headline figure.
 *
 * Ten, because the headlights - the case the map exists to catch - disagree by
 * 23.15, and because dE 10 is where the palette checks already draw the line
 * between "slightly off" and "a different colour" (`docs/TESTING.md`).
 */
export const DISPUTED_FROM = 10;

/** @param {number} delta dE, or -1 for "seen by one view only" */
export function bandOf(delta) {
  if (delta < 0) return BAND_LONELY;
  for (let i = 0; i < BANDS.length - 1; i++) if (delta >= BANDS[i].min) return i;
  return BANDS.length - 2;
}

/**
 * @typedef {Object} DisagreementMap
 * @property {Int32Array} index voxel indices, ascending; x + nx * (y + ny * z)
 * @property {Float32Array} delta widest dE on that voxel, or -1 for one view
 * @property {Uint8Array} band index into `BANDS`
 * @property {Uint8Array} viewA index into VIEW_NAMES of one side of the widest pair
 * @property {Uint8Array} viewB the other side, or 255 when there is none
 * @property {Uint8Array} colorA palette slot the first view gave
 * @property {Uint8Array} colorB palette slot the second gave, or 0
 * @property {Uint32Array} counts voxels per band, same order as `BANDS`
 * @property {number} total voxels at least one view reached
 * @property {number} disputed voxels at or above `DISPUTED_FROM`
 * @property {number} nx @property {number} ny @property {number} nz
 */

/**
 * Build the map from what the painting pass already saw.
 *
 * No extra ray is cast: `paintFromViews` keeps, per view, how far along each
 * ray the first voxel sat, which is exactly "this view saw that voxel and gave
 * it this colour". Walking those depth buffers again costs one pass over
 * 6 x N^2 pixels and no pass over the volume at all.
 *
 * Mirrored views are left out on purpose. A synthesised view is its opposite's
 * art flipped over, so any disagreement it reports is an invention of this
 * tool, not something the artist drew - and the whole point is to name the
 * drawing at fault.
 *
 * @param {Record<string, {mask: Uint8Array, color: Uint8Array}>} raster
 * @param {Record<string, Int32Array>} seen view name -> ray depth or -1
 * @param {number} N grid size
 * @param {import('./palette.js').Palette} palette
 * @param {string[]} [only] view names to count; defaults to everything in `seen`
 * @returns {DisagreementMap}
 */
export function disagreementMap(raster, seen, N, palette, only) {
  const names = (only ?? Object.keys(seen)).filter((n) => seen[n] && raster[n]);

  let hits = 0;
  for (const name of names) {
    const depth = seen[name];
    for (let o = 0; o < depth.length; o++) if (depth[o] >= 0) hits++;
  }

  // One float per hit, not one object: voxel index, view and palette slot pack
  // into 2^38 at the largest grid, well inside what a double holds exactly, and
  // sorting the packed keys groups the hits by voxel for free. At 512 that is
  // 12 MB rather than a Map of a million entries.
  const keys = new Float64Array(hits);
  let k = 0;
  for (const name of names) {
    const vi = VIEW_NAMES.indexOf(/** @type {any} */ (name));
    const geom = VIEW_GEOM[name];
    const depth = seen[name];
    const color = raster[name].color;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        const o = v * N + u;
        const d = depth[o];
        if (d < 0) continue;
        const [x, y, z] = geom.ray(u, v, d, N);
        const vox = x + N * (y + N * z);
        keys[k++] = vox * 2048 + vi * 256 + color[o];
      }
    }
  }
  keys.sort();

  // dE between two palette slots is asked for again and again - a lorry's flank
  // is one pair repeated thousands of times - and the formula is not cheap.
  const cache = new Float32Array(256 * 256).fill(-2);
  const colors = palette.colors;
  const between = (a, b) => {
    if (a === b) return 0;
    const ci = a * 256 + b;
    let d = cache[ci];
    if (d !== -2) return d;
    d = ciede2000Packed(colors[a] | 0, colors[b] | 0);
    cache[ci] = d;
    cache[b * 256 + a] = d;
    return d;
  };

  let groups = 0;
  for (let i = 0; i < hits; i++) {
    if (i === 0 || Math.floor(keys[i] / 2048) !== Math.floor(keys[i - 1] / 2048)) groups++;
  }

  const index = new Int32Array(groups);
  const delta = new Float32Array(groups);
  const band = new Uint8Array(groups);
  const viewA = new Uint8Array(groups).fill(255);
  const viewB = new Uint8Array(groups).fill(255);
  const colorA = new Uint8Array(groups);
  const colorB = new Uint8Array(groups);
  const counts = new Uint32Array(BANDS.length);
  let disputed = 0;

  /** @type {number[]} */
  const gv = [];
  /** @type {number[]} */
  const gc = [];
  let g = 0;
  let i = 0;
  while (i < hits) {
    const vox = Math.floor(keys[i] / 2048);
    gv.length = 0;
    gc.length = 0;
    while (i < hits && Math.floor(keys[i] / 2048) === vox) {
      const rest = keys[i] - vox * 2048;
      gv.push((rest / 256) | 0);
      gc.push(rest % 256);
      i++;
    }
    let best = -1;
    let bi = 0;
    let bj = 0;
    for (let a = 0; a < gv.length; a++) {
      for (let b = a + 1; b < gv.length; b++) {
        const d = between(gc[a], gc[b]);
        if (d > best) { best = d; bi = a; bj = b; }
      }
    }
    index[g] = vox;
    if (gv.length < 2) {
      delta[g] = -1;
      viewA[g] = gv[0];
      colorA[g] = gc[0];
    } else {
      delta[g] = best;
      viewA[g] = gv[bi];
      viewB[g] = gv[bj];
      colorA[g] = gc[bi];
      colorB[g] = gc[bj];
      if (best >= DISPUTED_FROM) disputed++;
    }
    band[g] = bandOf(delta[g]);
    counts[band[g]]++;
    g++;
  }

  return {
    index, delta, band, viewA, viewB, colorA, colorB,
    counts, total: groups, disputed,
    nx: N, ny: N, nz: N,
  };
}

/**
 * What the map says about one voxel, or null when no view reached it - which is
 * what a voxel added by hand after the build looks like.
 *
 * @param {DisagreementMap} map
 * @returns {{delta: number, band: number, viewA: number, viewB: number,
 *   colorA: number, colorB: number} | null}
 */
export function mapAt(map, x, y, z) {
  const want = x + map.nx * (y + map.ny * z);
  let lo = 0;
  let hi = map.index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = map.index[mid];
    if (v === want) {
      return {
        delta: map.delta[mid],
        band: map.band[mid],
        viewA: map.viewA[mid],
        viewB: map.viewB[mid],
        colorA: map.colorA[mid],
        colorB: map.colorB[mid],
      };
    }
    if (v < want) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

/**
 * The same exposed faces the renderer already draws, recoloured by band.
 *
 * Deliberately not `Volume.buildFaceInstances`: that one clears the volume's
 * dirty set as it goes, and borrowing it to draw a *view* of the model would
 * leave the renderer believing it had been handed geometry it never received.
 * This walk only reads, and it reads occupancy, never a face byte.
 *
 * Slot numbering: band b is drawn with palette slot b + 1, so slot 0 keeps its
 * meaning of "no colour" and the shader discards nothing that should be seen.
 *
 * @param {import('./volume.js').Volume} volume
 * @param {DisagreementMap} map
 * @returns {{buffer: ArrayBuffer, count: number}}
 */
export function mapInstances(volume, map) {
  const bandAt = bandLookup(map);
  const skin = 12 * (volume.nx * volume.ny + volume.ny * volume.nz + volume.nx * volume.nz);
  let cap = Math.max(1024, Math.min(volume.solidCount * 3, skin));
  let buf = new ArrayBuffer(cap * 8);
  let i16 = new Int16Array(buf);
  let u8 = new Uint8Array(buf);
  let n = 0;
  const grow = () => {
    cap *= 2;
    const nb = new ArrayBuffer(cap * 8);
    new Uint8Array(nb).set(u8.subarray(0, n * 8));
    buf = nb;
    i16 = new Int16Array(buf);
    u8 = new Uint8Array(buf);
  };

  const nx = volume.nx;
  const ny = volume.ny;
  volume.forEachSolid((x, y, z) => {
    // One lookup per voxel, not per face: every face of a voxel wears the same
    // band, because the disagreement is about the voxel's colour, not one of
    // its sides.
    const slot = bandAt(x + nx * (y + ny * z)) + 1;
    for (let d = 0; d < 6; d++) {
      if (volume.get(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2])) continue;
      if (n === cap) grow();
      const o16 = n * 4;
      i16[o16] = x;
      i16[o16 + 1] = y;
      i16[o16 + 2] = z;
      u8[n * 8 + 6] = d;
      u8[n * 8 + 7] = slot;
      n++;
    }
  });

  return { buffer: buf.slice(0, n * 8), count: n };
}

/**
 * Voxel index -> band, in constant time.
 *
 * A binary search costs twenty-one steps per voxel, and a 512 model has
 * twenty-five million of them; an open-addressed table costs one probe and
 * about five bytes per entry. Keys are shifted by one so that zero means
 * "empty slot" and voxel 0 is still storable.
 *
 * @param {DisagreementMap} map
 * @returns {(vox: number) => number} band index, `BAND_LONELY` when unseen
 */
export function bandLookup(map) {
  let size = 16;
  while (size < map.index.length * 2) size *= 2;
  const mask = size - 1;
  const keys = new Int32Array(size);
  const vals = new Uint8Array(size);
  for (let i = 0; i < map.index.length; i++) {
    const key = map.index[i] + 1;
    let s = (Math.imul(key, 2654435761) >>> 0) & mask;
    while (keys[s] !== 0) s = (s + 1) & mask;
    keys[s] = key;
    vals[s] = map.band[i];
  }
  return (vox) => {
    const key = vox + 1;
    let s = (Math.imul(key, 2654435761) >>> 0) & mask;
    for (;;) {
      const k = keys[s];
      if (k === key) return vals[s];
      if (k === 0) return BAND_LONELY;
      s = (s + 1) & mask;
    }
  };
}

/**
 * The map's own lookup texture: six bands in slots 1..6, everything else
 * transparent. Same shape as `Palette.toTextureData`, so the renderer uploads
 * it through the path it already has.
 *
 * @param {Array<[number, number, number]>} rgb six colours, loudest band first
 * @param {number} [size] palette width, PALETTE_MAX in the product
 * @returns {Uint8Array}
 */
export function bandTextureData(rgb, size = 256) {
  const out = new Uint8Array(size * 4);
  for (let b = 0; b < rgb.length && b + 1 < size; b++) {
    const o = (b + 1) * 4;
    out[o] = rgb[b][0];
    out[o + 1] = rgb[b][1];
    out[o + 2] = rgb[b][2];
    out[o + 3] = 255;
  }
  return out;
}
