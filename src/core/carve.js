// @ts-check
/**
 * Shape-from-silhouette carving (the visual hull) plus per-face colour transfer.
 *
 * The geometry step is an intersection: a voxel survives only if every supplied
 * view sees something at the pixel that voxel projects to. Worth knowing up
 * front - opposite views carry the *same* silhouette for an opaque object, so
 * back/left/bottom add no geometry beyond front/right/top. What they add is
 * colour on the faces pointing away from you, which is the whole reason this
 * looks better than a single-colour voxel model.
 *
 * The known limit: a visual hull cannot represent a concavity that no
 * silhouette reveals - the inside of a hood, a dimple, a blind hole. Those come
 * out filled and have to be carved by hand. Two unrelated blobs in different
 * views also generate phantom volume where their projections cross.
 */

import { Volume, DIRS } from './volume.js';
import { VIEW_GEOM, VIEW_NAMES } from './views.js';
import { findLookalikeViews } from './diagnose.js';

/** Which view looks at the opposite side of the model. */
const OPPOSITE = {
  front: 'back', back: 'front',
  right: 'left', left: 'right',
  top: 'bottom', bottom: 'top',
};

/**
 * How an opposite view's (u, v) relates to this one's - both horizontal pairs
 * are plain mirrors.
 *
 * Top and bottom are deliberately absent. A model's underside is not its roof
 * flipped over: mirroring a car's top view paints the bodywork's red onto the
 * undersides of its tyres, and a character's hair onto the soles of its feet.
 * The underside is better served by the nearest-real-colour spread below, and
 * it is the facing least often seen anyway.
 */
const MIRROR_AXIS = {
  front: 'h', back: 'h', right: 'h', left: 'h',
};

/**
 * @typedef {Object} CarveStats
 * @property {number} solid voxels in the finished model
 * @property {number} painted faces coloured directly from a source view
 * @property {number} inferred faces that had to borrow a colour
 * @property {string[]} mirrored views synthesised from their opposite
 * @property {number} ms wall-clock time
 * @property {Array<{a: string, b: string, similarity: number}>} lookalikes views
 *   that span different axes yet show the same silhouette, which means one of
 *   them is the wrong drawing for its slot
 */

/**
 * @param {import('./views.js').SourceView[]} views
 * @param {number} N grid size
 * @param {import('./palette.js').Palette} palette
 * @param {{mirrorMissing?: boolean}} [opts]
 * @returns {{volume: Volume, stats: CarveStats}}
 */
export function carve(views, N, palette, opts = {}) {
  const t0 = performance.now();
  const N1 = N - 1;

  // Sample every view before choosing a single colour, then seed the palette
  // with the colours that actually cover the most area.
  //
  // Filling it in arrival order is how a white box lorry comes out entirely
  // grey: the anti-aliased body contributes hundreds of near-identical greys,
  // they take all 255 slots, and the red cab - met later - gets resolved to
  // the nearest thing already there, which is a grey.
  /** @type {Record<string, {mask: Uint8Array, rgb: Int32Array}>} */
  const sampled = {};
  const active = [];
  for (const v of views) {
    if (!v.enabled || v.trim.w === 0) continue;
    sampled[v.name] = v.sampleCells(N);
    active.push(v.name);
  }
  seedPalette(sampled, palette);

  /** @type {Record<string, {mask: Uint8Array, color: Uint8Array}>} */
  const raster = {};
  for (const name of active) {
    const { mask, rgb } = sampled[name];
    const color = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = rgb[i];
      color[i] = palette.add((p >> 16) & 255, (p >> 8) & 255, p & 255);
    }
    raster[name] = { mask, color };
  }

  const vol = Volume.cube(N);
  if (active.length === 0) {
    return { volume: vol, stats: { solid: 0, painted: 0, inferred: 0, mirrored: [], lookalikes: [], ms: 0 } };
  }

  // Before mirroring: a synthesised view is a copy of its opposite by
  // construction, and comparing against it would only ever confirm that.
  const lookalikes = findLookalikeViews(raster, N);

  const mFront = raster.front?.mask;
  const mBack = raster.back?.mask;
  const mRight = raster.right?.mask;
  const mLeft = raster.left?.mask;
  const mTop = raster.top?.mask;
  const mBottom = raster.bottom?.mask;

  // The side views are constant along x, so a failed side test kills an entire
  // row before the inner loop ever runs.
  for (let z = 0; z < N; z++) {
    const rowTop = mTop ? z * N : 0;
    const rowBottom = mBottom ? (N1 - z) * N : 0;
    for (let y = 0; y < N; y++) {
      const vy = N1 - y;
      const row = vy * N;
      if (mRight && !mRight[row + (N1 - z)]) continue;
      if (mLeft && !mLeft[row + z]) continue;
      for (let x = 0; x < N; x++) {
        if (mFront && !mFront[row + x]) continue;
        if (mBack && !mBack[row + (N1 - x)]) continue;
        if (mTop && !mTop[rowTop + x]) continue;
        if (mBottom && !mBottom[rowBottom + x]) continue;
        vol.set(x, y, z, true);
      }
    }
  }

  // Mirroring happens after carving, never before: the back silhouette of an
  // opaque object is the mirrored front silhouette, so a mirrored view cannot
  // change the geometry. It only supplies colour for the faces pointing away
  // from the artist, which otherwise have no source at all.
  const mirrored = [];
  if (opts.mirrorMissing !== false) {
    for (const name of VIEW_NAMES) {
      if (raster[name] || !MIRROR_AXIS[name]) continue;
      const src = raster[OPPOSITE[name]];
      if (!src) continue;
      raster[name] = mirrorRaster(src, N, MIRROR_AXIS[name]);
      mirrored.push(name);
    }
  }

  const { painted, dominant } = paintFromViews(vol, raster, N);
  const inferred = inferMissingFaces(vol, dominant);

  return {
    volume: vol,
    stats: {
      solid: vol.solidCount,
      painted,
      inferred,
      mirrored,
      lookalikes,
      ms: performance.now() - t0,
    },
  };
}

/**
 * Fill the palette in order of how much of the model each colour covers.
 *
 * Palette.add keeps the first entries it is given and resolves later ones to
 * the nearest already present, so handing it colours most-used first is the
 * whole mechanism: the real palette lands in the table and the anti-aliasing
 * fringes fall back onto it.
 *
 * @param {Record<string, {mask: Uint8Array, rgb: Int32Array}>} sampled
 * @param {import('./palette.js').Palette} palette
 */
function seedPalette(sampled, palette) {
  /** @type {Map<number, number>} packed colour -> cells covered */
  const counts = new Map();
  for (const name of Object.keys(sampled)) {
    const { mask, rgb } = sampled[name];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      counts.set(rgb[i], (counts.get(rgb[i]) ?? 0) + 1);
    }
  }
  const byUse = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [packed] of byUse) {
    palette.add((packed >> 16) & 255, (packed >> 8) & 255, packed & 255);
  }
}

/**
 * @param {{mask: Uint8Array, color: Uint8Array}} src
 * @param {number} N
 * @param {'h'|'v'} axis
 * @returns {{mask: Uint8Array, color: Uint8Array}}
 */
function mirrorRaster(src, N, axis) {
  const mask = new Uint8Array(N * N);
  const color = new Uint8Array(N * N);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const su = axis === 'h' ? N - 1 - u : u;
      const sv = axis === 'v' ? N - 1 - v : v;
      const s = sv * N + su;
      const o = v * N + u;
      mask[o] = src.mask[s];
      color[o] = src.color[s];
    }
  }
  return { mask, color };
}

/**
 * Walk one ray per source pixel and paint the first voxel it hits. Only the
 * frontmost voxel is visible from that view, so only it gets that pixel.
 * @returns {{painted: number, dominant: number}} dominant is the most-used
 *   palette index, used as the last-resort fill so no face can stay blank
 */
function paintFromViews(vol, raster, N) {
  let painted = 0;
  const histogram = new Uint32Array(256);
  for (const name of Object.keys(raster)) {
    const geom = VIEW_GEOM[name];
    const { mask, color } = raster[name];
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        const o = v * N + u;
        if (!mask[o]) continue;
        for (let d = 0; d < N; d++) {
          const [x, y, z] = geom.ray(u, v, d, N);
          if (!vol.get(x, y, z)) continue;
          vol.setFace(x, y, z, geom.face, color[o]);
          histogram[color[o]]++;
          painted++;
          break;
        }
      }
    }
  }

  let dominant = 1;
  let best = 0;
  for (let i = 1; i < 256; i++) {
    if (histogram[i] > best) {
      best = histogram[i];
      dominant = i;
    }
  }
  return { painted, dominant };
}

/**
 * Give every exposed face a colour. A face can end up bare because it points
 * into a concavity, or because the artist only supplied three views. Rather
 * than leaving holes, borrow: first from another face of the same voxel, then
 * from the neighbour sharing that facing, and finally from the model's
 * dominant colour.
 *
 * That last step is not cosmetic. Palette index 0 means "no colour", the shader
 * discards it, and a discarded face is a literal hole you can see through - so
 * this function must leave nothing at 0.
 *
 * @param {Volume} vol
 * @param {number} fallback palette index used when nothing can be borrowed
 * @returns {number} faces filled in this way
 */
function inferMissingFaces(vol, fallback = 1) {
  const nx = vol.nx;
  const ny = vol.ny;
  const index = (x, y, z) => x + nx * (y + ny * z);

  // Only surface voxels matter - the interior has no faces to colour, and
  // leaving it out keeps this proportional to the model's skin rather than its
  // volume.
  /** @type {Map<number, number>} surface voxel -> representative colour, 0 = still unknown */
  const own = new Map();

  vol.forEachSolid((x, y, z) => {
    let exposed = false;
    let seen = 0;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (!vol.get(x + dx, y + dy, z + dz)) exposed = true;
      const c = vol.getFace(x, y, z, d);
      if (c !== 0 && seen === 0) seen = c;
    }
    if (exposed) own.set(index(x, y, z), seen);
  });

  // Breadth-first from every voxel a view actually reached, so an uncoloured
  // patch takes the colour of the *nearest* real one. This is what keeps the
  // inward-facing side of a wheel black: the tyre beside it is two voxels away
  // and the bodywork above it is three, so the tyre wins. Picking any adjacent
  // colour, as a simple flood does, would hand it whatever happened to be next
  // to it - usually the large panel above.
  const queue = [];
  for (const [i, c] of own) if (c !== 0) queue.push(i);

  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const c = /** @type {number} */ (own.get(i));
    const x = i % nx;
    const y = ((i / nx) | 0) % ny;
    const z = (i / (nx * ny)) | 0;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      const ax = x + dx, ay = y + dy, az = z + dz;
      if (!vol.inBounds(ax, ay, az)) continue;
      const ni = index(ax, ay, az);
      // Anything but 0 means "not a surface voxel" or "already assigned".
      if (own.get(ni) !== 0) continue;
      own.set(ni, c);
      queue.push(ni);
    }
  }

  let inferred = 0;
  vol.forEachSolid((x, y, z) => {
    const c = own.get(index(x, y, z)) || fallback;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (vol.get(x + dx, y + dy, z + dz)) continue;
      if (vol.getFace(x, y, z, d) !== 0) continue;
      vol.setFace(x, y, z, d, c);
      inferred++;
    }
  });

  return inferred;
}
