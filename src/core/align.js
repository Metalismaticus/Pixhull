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
 * How each view's image axes map onto model axes, sign included.
 *
 * This mirrors VIEW_GEOM's uv functions exactly - `front` has u = x and
 * v = N-1-y, so its horizontal axis runs with +x and its vertical against +y -
 * and lets everything be compared in model space rather than image space.
 */
const IMAGE_AXES = {
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

/** @param {Float64Array} p */
function reversed(p) {
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[p.length - 1 - i];
  return out;
}

/**
 * Everything a single orientation of one view contributes to scoring: an
 * occupancy profile along each model axis it spans, the mean colour of the
 * slices at each end of those axes, and the mean colour overall.
 */
function describe(name, oriented) {
  const conv = IMAGE_AXES[name];
  const cols = new Float64Array(WORK);
  const rows = new Float64Array(WORK);
  let sr = 0, sg = 0, sb = 0, n = 0;

  for (let b = 0; b < WORK; b++) {
    for (let a = 0; a < WORK; a++) {
      const i = b * WORK + a;
      if (!oriented.on[i]) continue;
      cols[a]++;
      rows[b]++;
      const c = oriented.rgb[i];
      sr += (c >> 16) & 255;
      sg += (c >> 8) & 255;
      sb += c & 255;
      n++;
    }
  }

  /** @type {Record<string, Float64Array>} */
  const profile = {};
  /** @type {Record<string, {min: number[], max: number[]}>} */
  const caps = {};

  for (const which of /** @type {const} */ (['u', 'v'])) {
    const [axis, sign] = conv[which];
    const along = which === 'u' ? cols : rows;
    profile[axis] = sign > 0 ? along : reversed(along);
    caps[axis] = capColours(oriented, which, sign);
  }

  return { profile, caps, mean: n ? [sr / n, sg / n, sb / n] : [0, 0, 0], area: n };
}

/** Mean colour of the outer quarter at each end of one image axis, in model order. */
function capColours(oriented, which, sign) {
  const quarter = Math.max(1, Math.round(WORK / 4));
  const low = [0, 0, 0];
  const high = [0, 0, 0];
  let lowN = 0;
  let highN = 0;

  for (let b = 0; b < WORK; b++) {
    for (let a = 0; a < WORK; a++) {
      const i = b * WORK + a;
      if (!oriented.on[i]) continue;
      const along = which === 'u' ? a : b;
      const target = along < quarter ? low : along >= WORK - quarter ? high : null;
      if (!target) continue;
      const c = oriented.rgb[i];
      target[0] += (c >> 16) & 255;
      target[1] += (c >> 8) & 255;
      target[2] += c & 255;
      if (target === low) lowN++; else highN++;
    }
  }

  const norm = (t, count) => (count ? [t[0] / count, t[1] / count, t[2] / count] : null);
  const a = norm(low, lowN);
  const b = norm(high, highN);
  // Image-low is model-low only when the axis runs with the image.
  return sign > 0 ? { min: a, max: b } : { min: b, max: a };
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

/** 1 for identical colours, 0 for opposite corners of the cube. */
function colourAgreement(a, b) {
  if (!a || !b) return 0;
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return Math.max(0, 1 - d / 441.673);
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

  // Each view keeps its quarter turn and chooses between four ways of sitting
  // in it; a view the artist has oriented by hand gets exactly one.
  const options = active.map((view) => {
    const stamp = stampOf(view);
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
      ...describe(view.name, orient(stamp, c.rotate, c.flipH, view.flipV)),
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

  const pick = new Array(active.length).fill(0);
  const best = { score: -Infinity, pick: pick.slice() };

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
          total += CAP_WEIGHT * colourAgreement(chosen[i].caps[axis][end], chosen[k].mean);
        }
      }
    }

    return total;
  };

  const walk = (index, chosen) => {
    if (index === active.length) {
      const s = score(chosen);
      if (s > best.score) {
        best.score = s;
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
