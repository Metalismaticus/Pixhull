// @ts-check
/**
 * Working out which way round each drawing goes.
 *
 * Matching dimensions is not enough. A top view laid out lengthways fits the
 * grid equally well turned a quarter clockwise or anticlockwise, so a solver
 * that only compares sizes picks one arbitrarily - and half the time the nose
 * of the vehicle ends up at the wrong end of the model. The front view then
 * paints the back, and every face where the drawings disagree about where the
 * cab stops gets painted from the wrong side: red speckles on a white box,
 * white streaks across a red cab. One misorientation, two symptoms.
 *
 * Two kinds of evidence settle it.
 *
 * Views that share a model axis are looking at the same object along it, so
 * their occupancy profiles along that axis must line up. That catches mirroring
 * between two views that both span the axis.
 *
 * It cannot, however, anchor an axis in space: reverse z in every view at once
 * and every profile still agrees, while the model is built back to front. The
 * anchor is that **the far slice of a view along an axis should look like the
 * view that stares down that axis**. The nose end of a side view should be the
 * colour of the front view; the top edge of it, the colour of the top view. On
 * a red-cabbed lorry that is decisive.
 *
 * "Looks like" has to mean more than "has the same average colour", though.
 * Averaged, the underside of a lorry is grey at both ends: the two dozen red
 * cells where the bumper wraps under vanish into a thousand grey ones, and
 * with them the only evidence of which end is the front. That is exactly how
 * the bottom view came to be mounted back to front while every other view
 * agreed with every other - and, the silhouette of a chassis being very
 * nearly symmetric, nothing about the shape objected.
 *
 * So an end is compared as a histogram of colours rather than as a mean, and
 * each colour is weighted by how rare it is across the sheet. A grey that
 * turns up in all six drawings says nothing about which end is which; a red
 * that turns up in three says a great deal. Measured on the lorry, the mean
 * put the two answers within 3% of each other and picked the wrong one, while
 * the weighted histogram separates them by 20%.
 *
 * With at most six views and four orientations left to settle for each - a half
 * turn and a mirror, the quarter turn having been fixed by dimensions - the
 * search is exhaustive. Four thousand combinations of cheap table lookups beats
 * a greedy walk that has to commit to a side view before anything spanning its
 * long axis has been placed, which is exactly where the greedy version failed.
 */

import { ALPHA_THRESHOLD } from './views.js';

/** Resolution the profiles are computed at. Shape, not detail, is what matters. */
const WORK = 48;

/**
 * Levels per channel the colour vocabulary is quantised to.
 *
 * Six is the coarsest setting that still keeps a red cab apart from an orange
 * indicator, and coarse is what is wanted: anti-aliasing spreads one painted
 * surface over dozens of near-identical values, and two views of the same
 * surface never land on the same one. Four levels merge red into brown and the
 * margin collapses to 2%; eight splits the greys back up and gains nothing.
 */
const LEVELS = 6;
const BINS = LEVELS * LEVELS * LEVELS;

/** @param {number} c packed 0xRRGGBB */
function colourBin(c) {
  const r = Math.min(LEVELS - 1, (((c >> 16) & 255) * LEVELS) >> 8);
  const g = Math.min(LEVELS - 1, (((c >> 8) & 255) * LEVELS) >> 8);
  const b = Math.min(LEVELS - 1, ((c & 255) * LEVELS) >> 8);
  return (r * LEVELS + g) * LEVELS + b;
}

/**
 * How each view's image axes map onto model axes, sign included.
 *
 * This mirrors VIEW_GEOM's uv functions exactly - `front` has u = x and
 * v = N-1-y, so its horizontal axis runs with +x and its vertical against +y -
 * and lets everything be compared in model space rather than image space.
 */
export const IMAGE_AXES = {
  front: { u: ['x', 1], v: ['y', -1] },
  back: { u: ['x', -1], v: ['y', -1] },
  right: { u: ['z', -1], v: ['y', -1] },
  left: { u: ['z', 1], v: ['y', -1] },
  top: { u: ['x', 1], v: ['z', 1] },
  bottom: { u: ['x', 1], v: ['z', -1] },
};

/** Model axes a view spans. */
const AXES_OF = {
  front: ['x', 'y'], back: ['x', 'y'],
  right: ['z', 'y'], left: ['z', 'y'],
  top: ['x', 'z'], bottom: ['x', 'z'],
};

/** Which view stares down each axis, from the positive and the negative side. */
const LOOKS_ALONG = {
  x: ['right', 'left'],
  y: ['top', 'bottom'],
  z: ['front', 'back'],
};

/** How much a cap match counts against a profile match. */
const CAP_WEIGHT = 1.5;

/**
 * How much better an arrangement must score before it is worth disturbing a
 * drawing the artist gave us.
 *
 * A near-symmetric subject - the back of a box lorry, say - scores almost the
 * same mirrored as not, and acting on that margin just moves the door handles
 * to the wrong side for no gain. Below this the arrangement that changes
 * fewest drawings wins.
 */
const DECISIVE = 0.02;

/**
 * A square stamp of the view's trimmed content - coverage and colour - before
 * any orientation is applied.
 * @param {import('./views.js').SourceView} view
 */
function stampOf(view) {
  const { x: tx, y: ty, w, h } = view.trim;
  const { width, data } = view.image;
  const on = new Uint8Array(WORK * WORK);
  const rgb = new Int32Array(WORK * WORK);
  for (let b = 0; b < WORK; b++) {
    const sy = ty + Math.min(h - 1, Math.floor(((b + 0.5) * h) / WORK));
    for (let a = 0; a < WORK; a++) {
      const sx = tx + Math.min(w - 1, Math.floor(((a + 0.5) * w) / WORK));
      const i = (sy * width + sx) * 4;
      if (data[i + 3] < ALPHA_THRESHOLD) continue;
      on[b * WORK + a] = 1;
      rgb[b * WORK + a] = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    }
  }
  return { on, rgb };
}

/**
 * Turn and mirror the stamp the way SourceView.toSource does, so what is scored
 * here is what will actually be sampled.
 */
function orient(stamp, rotate, flipH, flipV) {
  const on = new Uint8Array(WORK * WORK);
  const rgb = new Int32Array(WORK * WORK);
  const last = WORK - 1;
  for (let b = 0; b < WORK; b++) {
    for (let a = 0; a < WORK; a++) {
      let tx, ty;
      switch (rotate) {
        case 90: tx = b; ty = last - a; break;
        case 180: tx = last - a; ty = last - b; break;
        case 270: tx = last - b; ty = a; break;
        default: tx = a; ty = b;
      }
      if (flipH) tx = last - tx;
      if (flipV) ty = last - ty;
      const from = ty * WORK + tx;
      const to = b * WORK + a;
      on[to] = stamp.on[from];
      rgb[to] = stamp.rgb[from];
    }
  }
  return { on, rgb };
}

/**
 * How much each colour is worth as evidence: a lot if it is rare across the
 * sheet, nothing if every drawing is full of it.
 *
 * Which colours a drawing contains does not depend on which way up it hangs,
 * so this is computed once, from the unturned stamps.
 *
 * @param {Array<{on: Uint8Array, rgb: Int32Array}>} stamps
 * @returns {Float64Array} weight per colour bin
 */
function rarity(stamps) {
  const count = new Float64Array(BINS);
  let total = 0;
  for (const s of stamps) {
    for (let i = 0; i < s.on.length; i++) {
      if (!s.on[i]) continue;
      count[colourBin(s.rgb[i])]++;
      total++;
    }
  }
  const idf = new Float64Array(BINS);
  for (let k = 0; k < BINS; k++) if (count[k] > 0) idf[k] = Math.log(1 + total / count[k]);
  return idf;
}

/**
 * Weighted, normalised colour histogram of the cells a predicate keeps.
 *
 * @param {{on: Uint8Array, rgb: Int32Array}} oriented
 * @param {Float64Array} idf
 * @param {(a: number, b: number) => boolean} [keep] all cells if omitted
 */
function histOf(oriented, idf, keep) {
  const h = new Float64Array(BINS);
  let sum = 0;
  for (let b = 0; b < WORK; b++) {
    for (let a = 0; a < WORK; a++) {
      const i = b * WORK + a;
      if (!oriented.on[i] || (keep && !keep(a, b))) continue;
      const k = colourBin(oriented.rgb[i]);
      h[k] += idf[k];
      sum += idf[k];
    }
  }
  if (sum > 0) for (let k = 0; k < BINS; k++) h[k] /= sum;
  return h;
}

/** @param {Float64Array} p */
function reversed(p) {
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[p.length - 1 - i];
  return out;
}

/**
 * Everything a single orientation of one view contributes to scoring: an
 * occupancy profile along each model axis it spans, and a colour histogram of
 * the slices at each end of those axes.
 *
 * @param {string} name
 * @param {{on: Uint8Array, rgb: Int32Array}} oriented
 * @param {Float64Array} idf
 */
function describe(name, oriented, idf) {
  const conv = IMAGE_AXES[name];
  const cols = new Float64Array(WORK);
  const rows = new Float64Array(WORK);
  let n = 0;

  for (let b = 0; b < WORK; b++) {
    for (let a = 0; a < WORK; a++) {
      if (!oriented.on[b * WORK + a]) continue;
      cols[a]++;
      rows[b]++;
      n++;
    }
  }

  /** @type {Record<string, Float64Array>} */
  const profile = {};
  /** @type {Record<string, {min: Float64Array, max: Float64Array}>} */
  const caps = {};

  for (const which of /** @type {const} */ (['u', 'v'])) {
    const [axis, sign] = conv[which];
    const along = which === 'u' ? cols : rows;
    profile[axis] = sign > 0 ? along : reversed(along);
    caps[axis] = capHists(oriented, which, sign, idf);
  }

  return { profile, caps, area: n };
}

/** Colour histograms of the outer quarter at each end of one image axis, in model order. */
function capHists(oriented, which, sign, idf) {
  const quarter = Math.max(1, Math.round(WORK / 4));
  const low = histOf(oriented, idf, (a, b) => (which === 'u' ? a : b) < quarter);
  const high = histOf(oriented, idf, (a, b) => (which === 'u' ? a : b) >= WORK - quarter);
  // Image-low is model-low only when the axis runs with the image.
  return sign > 0 ? { min: low, max: high } : { min: high, max: low };
}

/**
 * How alike two profiles are, once each is normalised to unit total. The views
 * are different sizes and different drawings; only the distribution matters.
 */
function profileAgreement(p, q) {
  let sp = 0;
  let sq = 0;
  for (let i = 0; i < p.length; i++) {
    sp += p[i];
    sq += q[i];
  }
  if (sp === 0 || sq === 0) return 0;
  let distance = 0;
  for (let i = 0; i < p.length; i++) distance += Math.abs(p[i] / sp - q[i] / sq);
  return 1 - distance / 2;
}

/**
 * Histogram intersection: 1 when two colour distributions coincide, 0 when
 * they share nothing. Both sides are already normalised, so this is the share
 * of one distribution the other accounts for.
 */
function histAgreement(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < BINS; i++) s += Math.min(a[i], b[i]);
  return s;
}

/**
 * Settle the half-turn and mirror of every view so they agree with each other.
 *
 * @param {import('./views.js').SourceView[]} views
 * @returns {Array<{name: string, rotate: number, flipH: boolean}>} what changed
 */
export function alignViews(views) {
  const active = views.filter((v) => v.enabled && v.trim.w > 0 && AXES_OF[v.name]);
  if (active.length < 2) return [];

  const stamps = active.map(stampOf);
  const idf = rarity(stamps);
  // What a drawing is *made of* does not change when it is turned, so the
  // whole-view histogram every end is compared against is computed once.
  const whole = stamps.map((s) => histOf(s, idf));

  // Each view keeps its quarter turn and chooses between four ways of sitting
  // in it; a view the artist has oriented by hand gets exactly one.
  const options = active.map((view, index) => {
    const stamp = stamps[index];
    const base = view.rotate % 180;
    const combos = view.orientLocked
      ? [{ rotate: view.rotate, flipH: view.flipH }]
      : [
          { rotate: base, flipH: false },
          { rotate: base, flipH: true },
          { rotate: (base + 180) % 360, flipH: false },
          { rotate: (base + 180) % 360, flipH: true },
        ];
    return combos.map((c) => ({
      ...c,
      ...describe(view.name, orient(stamp, c.rotate, c.flipH, view.flipV), idf),
    }));
  });

  /** Mean colour of whichever view stares down `axis` from `side`, if supplied. */
  const facing = {};
  for (const axis of ['x', 'y', 'z']) {
    const [plus, minus] = LOOKS_ALONG[axis];
    facing[axis] = {
      max: active.find((v) => v.name === plus),
      min: active.find((v) => v.name === minus),
    };
  }

  const best = { score: -Infinity, changes: Infinity, pick: new Array(active.length).fill(0) };

  const score = (chosen) => {
    let total = 0;

    // Views sharing an axis must agree along it.
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        for (const axis of AXES_OF[active[i].name]) {
          if (!AXES_OF[active[j].name].includes(axis)) continue;
          total += profileAgreement(chosen[i].profile[axis], chosen[j].profile[axis]);
        }
      }
    }

    // And each end of an axis must look like whatever stares down it. This is
    // what fixes an axis in space rather than merely making it self-consistent.
    for (let i = 0; i < active.length; i++) {
      for (const axis of AXES_OF[active[i].name]) {
        for (const end of /** @type {const} */ (['min', 'max'])) {
          const other = facing[axis][end];
          if (!other || other === active[i]) continue;
          const k = active.indexOf(other);
          total += CAP_WEIGHT * histAgreement(chosen[i].caps[axis][end], whole[k]);
        }
      }
    }

    return total;
  };

  const walk = (index, chosen) => {
    if (index === active.length) {
      const s = score(chosen);
      // How many drawings this arrangement would disturb. On a symmetric object
      // several arrangements score alike, and turning one for no gain is worse
      // than leaving it: the artist sees a change they did not ask for.
      let changes = 0;
      for (let i = 0; i < active.length; i++) {
        if (chosen[i].rotate !== active[i].rotate || chosen[i].flipH !== active[i].flipH) changes++;
      }
      if (s > best.score + DECISIVE || (s > best.score - DECISIVE && changes < best.changes)) {
        best.score = s;
        best.changes = changes;
        best.pick = chosen.map((c, i) => options[i].indexOf(c));
      }
      return;
    }
    for (const option of options[index]) {
      chosen[index] = option;
      walk(index + 1, chosen);
    }
  };
  walk(0, new Array(active.length));

  const changes = [];
  active.forEach((view, i) => {
    const chosen = options[i][best.pick[i]];
    if (chosen.rotate !== view.rotate || chosen.flipH !== view.flipH) {
      changes.push({ name: view.name, rotate: chosen.rotate, flipH: chosen.flipH });
      view.rotate = chosen.rotate;
      view.flipH = chosen.flipH;
    }
  });
  return changes;
}
