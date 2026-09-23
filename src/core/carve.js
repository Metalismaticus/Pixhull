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

/** Which view looks at the opposite side of the model. */
const OPPOSITE = {
  front: 'back', back: 'front',
  right: 'left', left: 'right',
  top: 'bottom', bottom: 'top',
};

/**
 * How an opposite view's (u, v) relates to this one's. Front/back and
 * left/right are horizontal mirrors of each other; top/bottom is a vertical one.
 */
const MIRROR_AXIS = {
  front: 'h', back: 'h', right: 'h', left: 'h', top: 'v', bottom: 'v',
};

/**
 * @typedef {Object} CarveStats
 * @property {number} solid voxels in the finished model
 * @property {number} painted faces coloured directly from a source view
 * @property {number} inferred faces that had to borrow a colour
 * @property {string[]} mirrored views synthesised from their opposite
 * @property {number} ms wall-clock time
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

  /** @type {Record<string, {mask: Uint8Array, color: Uint8Array}>} */
  const raster = {};
  const active = [];
  for (const v of views) {
    if (!v.enabled || v.trim.w === 0) continue;
    raster[v.name] = v.rasterize(N, palette);
    active.push(v.name);
  }

  const vol = Volume.cube(N);
  if (active.length === 0) {
    return { volume: vol, stats: { solid: 0, painted: 0, inferred: 0, mirrored: [], ms: 0 } };
  }

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
      if (raster[name]) continue;
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
    stats: { solid: vol.solidCount, painted, inferred, mirrored, ms: performance.now() - t0 },
  };
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
  let inferred = 0;
  /** @type {Array<[number, number, number, number]>} still bare: x,y,z,dir */
  let bare = [];

  vol.forEachSolid((x, y, z) => {
    let own = 0;
    for (let d = 0; d < 6; d++) {
      const c = vol.getFace(x, y, z, d);
      if (c !== 0) { own = c; break; }
    }
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (vol.get(x + dx, y + dy, z + dz)) continue;
      if (vol.getFace(x, y, z, d) !== 0) continue;
      if (own !== 0) {
        vol.setFace(x, y, z, d, own);
        inferred++;
      } else {
        bare.push([x, y, z, d]);
      }
    }
  });

  // Voxels no view could see at all: flood colour in from their neighbours.
  for (let pass = 0; pass < 8 && bare.length > 0; pass++) {
    /** @type {typeof bare} */
    const still = [];
    for (const [x, y, z, d] of bare) {
      let c = 0;
      for (let nd = 0; nd < 6 && c === 0; nd++) {
        const [dx, dy, dz] = DIRS[nd];
        if (!vol.get(x + dx, y + dy, z + dz)) continue;
        c = vol.getFace(x + dx, y + dy, z + dz, d);
      }
      if (c !== 0) {
        vol.setFace(x, y, z, d, c);
        inferred++;
      } else {
        still.push([x, y, z, d]);
      }
    }
    if (still.length === bare.length) break;
    bare = still;
  }

  // Anything the flood could not reach - typically a whole facing that no view
  // covers, such as the underside when only front/side/top were supplied.
  for (const [x, y, z, d] of bare) {
    vol.setFace(x, y, z, d, fallback);
    inferred++;
  }

  return inferred;
}
