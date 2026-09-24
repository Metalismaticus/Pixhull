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

import { Volume, DIRS, DIR_PX, DIR_NX, DIR_PY, DIR_NY, DIR_PZ, DIR_NZ } from './volume.js';
import { VIEW_GEOM, VIEW_NAMES } from './views.js';
import { findLookalikeViews } from './diagnose.js';
import { disagreementMap } from './disagree.js';
import { densityField, facingOf, FACE_DIRS } from './field.js';
import { PALETTE_MAX } from './palette.js';
import { quantize } from './quantize.js';

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
 * How much of the wall clock each stage takes, so a bar filling up moves at a
 * believable speed instead of jumping.
 *
 * Measured on this bench at 512 (`tests/perf/carve.mjs` fixture, Node 22,
 * 2026-09-24): intersect 2.1 s, field 1.0 s, paint 1.4 s, slopes 1.0 s, infer
 * 2.9 s, sampling and rastering together under 0.1 s - though on real art the
 * sampling stage also pays for quantising the palette, so it is given a little
 * more than the synthetic figure. The shares hold well enough at 256; being a
 * few per cent out only makes the bar uneven, never wrong.
 */
const STAGE_WEIGHT = [
  ['sample', 0.05],
  ['intersect', 0.25],
  ['field', 0.12],
  ['paint', 0.17],
  ['slopes', 0.12],
  ['infer', 0.29],
];

/**
 * Turns "stage three is 40% done" into one rising number in 0..1.
 *
 * Every caller of `onProgress` is inside a loop that runs millions of times, so
 * the no-callback case has to cost nothing: without a callback this hands back
 * an object whose methods are empty.
 *
 * @param {((fraction: number, stage: string) => void) | undefined} onProgress
 */
function progressReporter(onProgress) {
  if (!onProgress) return { begin() {}, at() {}, done() {} };
  let base = 0;
  let weight = 1;
  let stage = 'sample';
  // A bar that goes backwards reads as a bug in the build. The inference stage
  // can genuinely revise its own estimate downwards - its queue grows while it
  // is being walked - so the number is held at its high-water mark instead.
  let high = 0;
  return {
    /** @param {string} name one of STAGE_WEIGHT's names */
    begin(name) {
      base = 0;
      for (const [n, w] of STAGE_WEIGHT) {
        if (n === name) { weight = w; break; }
        base += w;
      }
      stage = name;
      if (base > high) high = base;
      onProgress(high, stage);
    },
    /** @param {number} part 0..1 through the current stage */
    at(part) {
      const f = base + weight * (part < 0 ? 0 : part > 1 ? 1 : part);
      if (f > high) high = f;
      onProgress(high, stage);
    },
    done() {
      high = 1;
      onProgress(1, stage);
    },
  };
}

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
 * @param {{mirrorMissing?: boolean, slopeColour?: boolean, map?: boolean,
 *   onProgress?: (fraction: number, stage: string) => void}} [opts] `onProgress`
 *   is called with a number rising from 0 to 1 and the name of the stage
 *   running; it is how a build off the main thread can show how far it has got.
 *   `map` asks for the disagreement map alongside the model; it costs one pass
 *   over the depth buffers and nothing at all when left off.
 * @returns {{volume: Volume, map: import('./disagree.js').DisagreementMap|null,
 *   stats: CarveStats}}
 */
export function carve(views, N, palette, opts = {}) {
  const t0 = performance.now();
  const N1 = N - 1;
  const report = progressReporter(opts.onProgress);
  report.begin('sample');

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
    report.at((active.length / (views.length + 1)) * 0.5);
  }
  seedPalette(sampled, palette);
  report.at(0.75);

  /** @type {Record<string, {mask: Uint8Array, color: Uint8Array}>} */
  const raster = {};
  /**
   * Each view's own proportions, taken from the trimmed drawing rather than
   * from the grid: placement squashes views to the solved extents, so by the
   * time a raster exists two different drawings can share a box and one
   * drawing used twice can be in two boxes. The diagnosis needs the drawing.
   * @type {Record<string, number>}
   */
  const proportions = {};
  for (const v of views) {
    if (!v.enabled || v.trim.w === 0 || v.trim.h === 0) continue;
    proportions[v.name] = v.trim.w / v.trim.h;
  }
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
    return { volume: vol, map: null, stats: { solid: 0, painted: 0, inferred: 0, mirrored: [], lookalikes: [], ms: 0 } };
  }

  // Before mirroring: a synthesised view is a copy of its opposite by
  // construction, and comparing against it would only ever confirm that.
  const lookalikes = findLookalikeViews(raster, N, proportions);

  const mFront = raster.front?.mask;
  const mBack = raster.back?.mask;
  const mRight = raster.right?.mask;
  const mLeft = raster.left?.mask;
  const mTop = raster.top?.mask;
  const mBottom = raster.bottom?.mask;

  // The side views are constant along x, so a failed side test kills an entire
  // row before the inner loop ever runs.
  report.begin('intersect');
  for (let z = 0; z < N; z++) {
    // Every 16 slices, not every slice: at 512 that is 32 reports for two
    // seconds of work, which is a bar that moves without a callback in the way,
    // and at 64 it is still four.
    if ((z & 15) === 0) report.at(z / N);
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

  // One blurred copy of the model serves both passes below: the repaint reads
  // surface directions off it, and the inference reads its occupancy instead of
  // asking the chunked store about every neighbour of every voxel.
  report.begin('field');
  const box = vol.bounds();
  const field = box ? densityField(vol, box, 2, (part) => report.at(part)) : null;

  report.begin('paint');
  const { painted, dominant, seen } = paintFromViews(vol, raster, N, report);
  // Built from what the painting pass saw, before the slope repaint edits any
  // face: the map reports what the *drawings* said, not what the tool did with
  // it afterwards. Mirrored views are left out - see `disagreementMap`.
  const map = opts.map
    ? disagreementMap(raster, seen, N, palette, active)
    : null;
  report.begin('slopes');
  if (field && opts.slopeColour !== false) repaintSlopes(vol, raster, N, seen, field, box, report);
  field?.releaseGradient();
  report.begin('infer');
  const inferred = inferMissingFaces(vol, dominant, field, report);
  report.done();

  return {
    volume: vol,
    map,
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
 * Choose the palette from the histogram of all six views at once.
 *
 * Art that fits keeps every colour exactly, most used first - there is nothing
 * to decide. Art that does not fit is quantised (`quantize.js`): the 255 slots
 * are spread by how much colour error each one removes, instead of going to
 * whatever covered the most cells. Ordering by coverage was the old rule, and
 * it is how a white lorry came out grey all over - hundreds of anti-aliased
 * near-whites each covered more cells than the tail lights.
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
  if (counts.size <= PALETTE_MAX - 1) {
    const byUse = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [packed] of byUse) {
      palette.add((packed >> 16) & 255, (packed >> 8) & 255, packed & 255);
    }
    return;
  }
  const { colors, assign } = quantize(counts, PALETTE_MAX - 1);
  palette.adopt(colors, assign);
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
 * Repaint the faces of a sloped surface from the one drawing that faces it.
 *
 * A windscreen that slopes back is a staircase once it is on a grid, and its
 * treads and risers point in different directions - so the treads are painted
 * by the top view and the risers by the head-on view. That is right only if
 * the two drawings agree about where the glass starts, and they never quite
 * do: the artist drew the windscreen beginning at one place seen from the
 * front and another seen from above. The staircase then alternates between
 * them, one row red and the next white, one row blue and the next red, which
 * is exactly the banding on the cab.
 *
 * The surface itself is not stepped, though; only its lattice is. Reading the
 * direction it really faces off a blurred copy of the model gives the treads
 * and the risers the same answer, and once they take their colour from the
 * same drawing the banding has nothing to alternate between. Where a face
 * genuinely points along its own axis - the side of the box body, the roof -
 * that drawing is its own, and nothing changes.
 *
 * @param {Volume} vol
 * @param {Record<string, {mask: Uint8Array, color: Uint8Array}>} raster
 * @param {number} N
 */
function repaintSlopes(vol, raster, N, seen, field, box, report = { at() {} }) {
  /** face index -> the view that stares down it */
  const facing = {};
  for (const name of Object.keys(raster)) facing[VIEW_GEOM[name].face] = name;

  // The field already read the whole volume once to build itself, and kept
  // the occupancy; asking it saves a second pass over three million voxels.
  const at = (x, y, z) => field.solid(x, y, z);

  const zSpan = box.max[2] - box.min[2] + 1;
  for (let z = box.min[2]; z <= box.max[2]; z++) {
    if ((z & 15) === 0) report.at((z - box.min[2]) / zSpan);
    for (let y = box.min[1]; y <= box.max[1]; y++) {
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        if (!at(x, y, z)) continue;
        let want = -1;
        for (let d = 0; d < 6; d++) {
          const [ox, oy, oz] = FACE_DIRS[d];
          if (at(x + ox, y + oy, z + oz)) continue;
          // Only worth the lookup once we know some face here is exposed.
          if (want === -1) {
            want = facingOf(field, x, y, z);
            if (want < 0) break;
          }
          if (d === want) continue;
          // And never from the view staring at this face's back: on a fin one
          // voxel thick the far side would take the near side's colour.
          if ((d ^ 1) === want) continue;
          // And only where the lattice is standing in for a slope, which means
          // there is a step above or below this one. A single edge - the top
          // front edge of a box body, the corner of a bumper - is not a slope
          // however much the blurred gradient leans, and recolouring it from a
          // drawing that is not looking at it is what put white corners on the
          // cab. One step along and one step across lands on the next tread of
          // a staircase, and on nothing at all at a lone edge.
          const b = FACE_DIRS[want];
          let stepped = false;
          for (let k = 1; k <= 3 && !stepped; k++) {
            if (at(x + ox - b[0] * k, y + oy - b[1] * k, z + oz - b[2] * k)
              || at(x - ox + b[0] * k, y - oy + b[1] * k, z - oz + b[2] * k)) stepped = true;
          }
          if (!stepped) continue;
          const name = facing[want];
          if (!name) continue;
          const geom = VIEW_GEOM[name];
          const [u, v] = geom.uv(x, y, z, N);
          const o = v * N + u;
          if (!raster[name].mask[o]) continue;
          // That pixel belongs to whatever this view saw first along the ray.
          // Handing it to a voxel hidden behind something else paints the
          // underside of a lorry with the white of its flank, doubles a row of
          // tail lights onto the voxels behind them, and puts white corners on
          // a red cab - all reported, all the same mistake.
          if (seen[name][o] !== depthAlong(geom.face, x, y, z, N)) continue;
          vol.setFace(x, y, z, d, raster[name].color[o]);
        }
      }
    }
  }
}

/**
 * Walk one ray per source pixel and paint the first voxel it hits. Only the
 * frontmost voxel is visible from that view, so only it gets that pixel.
 * @returns {{painted: number, dominant: number}} dominant is the most-used
 *   palette index, used as the last-resort fill so no face can stay blank
 */
function paintFromViews(vol, raster, N, report = { at() {} }) {
  let painted = 0;
  const histogram = new Uint32Array(256);
  /** view name -> how far along each ray the first voxel sat, or -1 */
  const seen = {};
  const names = Object.keys(raster);
  let done = 0;
  for (const name of names) {
    report.at(done++ / names.length);
    const geom = VIEW_GEOM[name];
    const { mask, color } = raster[name];
    const depth = new Int32Array(N * N).fill(-1);
    seen[name] = depth;
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
          depth[o] = d;
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
  return { painted, dominant, seen };
}

/**
 * How far along a view's ray a voxel sits, so its own depth can be compared
 * with the depth of whatever that view actually saw first.
 *
 * @param {number} face the face index the view paints
 */
function depthAlong(face, x, y, z, N) {
  switch (face) {
    case DIR_PX: return N - 1 - x;
    case DIR_NX: return x;
    case DIR_PY: return N - 1 - y;
    case DIR_NY: return y;
    case DIR_PZ: return N - 1 - z;
    default: return z;
  }
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
function inferMissingFaces(vol, fallback = 1, field = null, report = { at() {} }) {
  const nx = vol.nx;
  const ny = vol.ny;
  const index = (x, y, z) => x + nx * (y + ny * z);
  // Asking the field is an array read; asking the volume walks a chunk table.
  // On a twenty-five-million-voxel model the difference is fourteen seconds.
  const filled = field ? field.solid : (x, y, z) => vol.get(x, y, z);

  // Only surface voxels matter - the interior has no faces to colour, and
  // leaving it out keeps this proportional to the model's skin rather than its
  // volume.
  /** @type {Map<number, number>} surface voxel -> representative colour, 0 = still unknown */
  const own = new Map();

  // Three passes over the model's skin, each about a third of the stage: find
  // the surface, spread colour outwards from what a view reached, write the
  // borrowed colours back.
  let walked = 0;
  const total = Math.max(1, vol.solidCount);
  vol.forEachSolid((x, y, z) => {
    if ((++walked & 0xffff) === 0) report.at((walked / total) / 3);
    let exposed = false;
    let seen = 0;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (!filled(x + dx, y + dy, z + dz)) exposed = true;
    }
    if (!exposed) return;
    for (let d = 0; d < 6; d++) {
      const c = vol.getFace(x, y, z, d);
      if (c !== 0) { seen = c; break; }
    }
    own.set(index(x, y, z), seen);
  });

  // Breadth-first from every voxel a view actually reached, so an uncoloured
  // patch takes the colour of the *nearest* real one. This is what keeps the
  // inward-facing side of a wheel black: the tyre beside it is two voxels away
  // and the bodywork above it is three, so the tyre wins. Picking any adjacent
  // colour, as a simple flood does, would hand it whatever happened to be next
  // to it - usually the large panel above.
  const queue = [];
  for (const [i, c] of own) if (c !== 0) queue.push(i);

  report.at(1 / 3);
  for (let head = 0; head < queue.length; head++) {
    if ((head & 0xffff) === 0) report.at(1 / 3 + (head / Math.max(1, queue.length)) / 3);
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
  let written = 0;
  report.at(2 / 3);
  vol.forEachSolid((x, y, z) => {
    if ((++written & 0xffff) === 0) report.at(2 / 3 + (written / total) / 3);
    const i = index(x, y, z);
    if (!own.has(i)) return;
    const c = own.get(i) || fallback;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (filled(x + dx, y + dy, z + dz)) continue;
      if (vol.getFace(x, y, z, d) !== 0) continue;
      vol.setFace(x, y, z, d, c);
      inferred++;
    }
  });

  return inferred;
}
