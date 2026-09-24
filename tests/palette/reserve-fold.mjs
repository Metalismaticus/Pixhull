// @ts-check
/**
 * The reservation does not spend two slots on one colour.
 *
 * `quantize()` hands a slot of its own, exactly as drawn, to every colour
 * covering at least 0.2% of the art. On flat pixel art that is the whole point:
 * the shades an artist puts down are far apart and worth keeping byte for byte.
 * On a rendered, anti-aliased sheet it was waste. Measured on the owner's lorry
 * (2026-09-24, grid 256, 17352 art colours): 48 colours pass the bar and 41 of
 * them sit within ΔE 1 of one of the other seven - `d9d9d9 d8d8d8 d9d8d9
 * d9d8d8 dad9da ...`, a slot each, none of them distinguishable from the next.
 * Forty-one slots that could show nothing, while the accents went to the cut.
 *
 * Three fixtures, because the fix has to move one number and not the others:
 *
 *  - "render" is that lorry in miniature: 40 near-neutrals within ΔE 0.9 of
 *    #d9d9d9, each heavy enough to reserve, plus 120 accents that are not. The
 *    reservation must come out of it holding one near-neutral, not forty, and
 *    the accents must come out closer for it.
 *  - "flat" is pixel art: 12 colours an artist chose, far apart, plus the same
 *    accents. Nothing may fold - every one of the 12 keeps its own slot and its
 *    own bytes, which is the state before this check existed.
 *  - "roomy" is the art that does not press on the palette at all: 73 colours
 *    into 128 slots, 65 of them within ΔE 1 of #f0f0f0 and so a single fold
 *    group. The fold buys nothing here, there are slots going spare, and
 *    exactness is worth more than a tidy palette - so every folded colour must
 *    get its slot back and land byte for byte.
 *
 * Red without the fix, measured 2026-09-24 by reverting `src/core/quantize.js`:
 * the render palette holds 28 slots indistinguishable from a heavier slot
 * instead of 0, the body itself spreads over ΔE 1.22 instead of staying under
 * 1, the accents' worst case is ΔE 25.1 instead of 19.4, and the reservation
 * count is not reported at all. The flat fixture stays green either way, on
 * purpose: it is the guard against over-merging, not the defect.
 *
 * The roomy fixture guards the other half of the fix - the loop that hands the
 * folded colours their slots back (`src/core/quantize.js`, the "no pressure"
 * branch). Red without it, measured 2026-09-24 by deleting that loop: palette
 * 9 colours instead of 73, 9 reserved instead of 73, 9 of 73 exact instead of
 * 73 of 73. The other two fixtures both go down the median-cut branch and do
 * not touch that loop at all, which is why this third one exists.
 */

import { quantize } from '../../src/core/quantize.js';
import { ciede2000Packed } from '../../src/core/color.js';

/** Palette size the fixtures are quantised into. Small, so the check is fast. */
const MAX = 64;
/**
 * Palette size for the roomy fixture, which needs more slots than it has
 * colours. Mine, not the owner's: 128 against 73 colours leaves the spare
 * slots plainly spare, so the case says "no pressure" and nothing else.
 */
const MAX_ROOMY = 128;
/** Two colours this close are the same colour to a viewer (`MERGE_DELTA_E`). */
const SAME = 1.0;
/**
 * How many redundant slots the render fixture may still hold. Mine, not the
 * owner's: one is room for the cut to place two boxes close together on its
 * own, which is a different question from the reservation wasting slots.
 * Measured: 28 before the fix, 0 after.
 */
const REDUNDANT_MAX = 1;
/**
 * Worst accent error allowed on the render fixture, in ΔE. Mine, and set
 * between the two measurements rather than under one of them: the accents reach
 * ΔE 25.1 while the reservation is wasting slots and ΔE 19.4 once it is not,
 * so 22 is the line that tells those apart. The absolute number is large
 * because the fixture deliberately asks 64 slots to describe 120 accents; what
 * the check watches is which side of the fix it lands on.
 */
const ACCENT_WORST = 22;

/**
 * Accents an artist would not want turned to mud: 120 saturated colours spread
 * around the hue circle, each covering too little to reserve.
 * @param {Map<number, number>} counts
 * @returns {number[]}
 */
function addAccents(counts) {
  const accents = [];
  for (let i = 0; i < 120; i++) {
    const h = (i * 360) / 120;
    const c = hsvPacked(h, 0.85, 0.5 + 0.5 * ((i % 3) / 2));
    if (counts.has(c)) continue;
    accents.push(c);
    counts.set(c, 20);
  }
  return accents;
}

/** @param {number} h degrees @param {number} s @param {number} v @returns {number} packed */
function hsvPacked(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}

/**
 * A render's body: near-neutrals around #d9d9d9 that nobody can tell apart,
 * each one heavy enough for the reservation to want a slot for it.
 */
function renderFixture() {
  /** @type {Map<number, number>} */
  const counts = new Map();
  const base = 0xd9d9d9;
  const body = [base];
  counts.set(base, 4000);
  for (let d = 1; d <= 3 && body.length < 40; d++) {
    for (let dr = -d; dr <= d && body.length < 40; dr++) {
      for (let dg = -d; dg <= d && body.length < 40; dg++) {
        for (let db = -d; db <= d && body.length < 40; db++) {
          const packed = ((0xd9 + dr) << 16) | ((0xd9 + dg) << 8) | (0xd9 + db);
          if (counts.has(packed)) continue;
          if (ciede2000Packed(packed, base) > 0.9) continue;
          body.push(packed);
          counts.set(packed, 3000);
        }
      }
    }
  }
  return { counts, body, accents: addAccents(counts) };
}

/** Pixel art: twelve flat colours an artist chose, far apart. */
function flatFixture() {
  /** @type {Map<number, number>} */
  const counts = new Map();
  const body = [];
  for (let i = 0; i < 12; i++) {
    const packed = hsvPacked((i * 360) / 12, 0.7, 0.3 + 0.06 * i);
    body.push(packed);
    counts.set(packed, 3000);
  }
  return { counts, body, accents: addAccents(counts) };
}

/**
 * Art that does not press on the palette: 65 near-neutrals within ΔE 1 of
 * #f0f0f0 - one fold group, keeper plus 64 followers - and 8 far-apart
 * accents, 73 colours in all for 128 slots. Every one of them is heavy enough
 * to reserve, and none of them has to share.
 */
function roomyFixture() {
  /** @type {Map<number, number>} */
  const counts = new Map();
  const base = 0xf0f0f0;
  const body = [base];
  counts.set(base, 4000);
  for (let dr = -4; dr <= 4; dr++) {
    for (let dg = -4; dg <= 4; dg++) {
      for (let db = -4; db <= 4; db++) {
        const packed = ((0xf0 + dr) << 16) | ((0xf0 + dg) << 8) | (0xf0 + db);
        if (counts.has(packed)) continue;
        if (ciede2000Packed(packed, base) > SAME) continue;
        body.push(packed);
        counts.set(packed, 3000);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    const packed = hsvPacked(i * 45, 0.85, 0.55);
    if (counts.has(packed)) continue;
    body.push(packed);
    counts.set(packed, 3000);
  }
  return { counts, body };
}

/**
 * Slots holding a colour indistinguishable from an earlier, heavier slot.
 * @param {number[]} colors
 */
function redundant(colors) {
  let n = 0;
  for (let i = 0; i < colors.length; i++) {
    for (let j = 0; j < i; j++) {
      if (ciede2000Packed(colors[i], colors[j]) <= SAME) { n++; break; }
    }
  }
  return n;
}

/**
 * @param {number[]} keys
 * @param {{colors: number[], assign: Map<number, number>}} out
 */
function worstError(keys, out) {
  let worst = 0;
  for (const k of keys) {
    const got = out.colors[/** @type {number} */ (out.assign.get(k))];
    const de = got === k ? 0 : ciede2000Packed(got, k);
    if (de > worst) worst = de;
  }
  return worst;
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {boolean} pass @param {string} got */
  const want = (name, pass, got) => {
    cases++;
    if (!pass) bad.push(name + ': ' + got);
  };

  // The render. One slot for the body, and the accents better for it.
  const render = renderFixture();
  const rq = quantize(render.counts, MAX);
  const rRedundant = redundant(rq.colors);
  const rAccent = worstError(render.accents, rq);
  want('render reserves one slot for the body', rq.reserved === 1, rq.reserved + ' reserved, want 1');
  want('render wastes no slot on a colour already there',
    rRedundant <= REDUNDANT_MAX, rRedundant + ' redundant slots, want at most ' + REDUNDANT_MAX);
  want('render body stays indistinguishable',
    worstError(render.body, rq) <= SAME,
    'worst body ΔE ' + worstError(render.body, rq).toFixed(2) + ', want at most ' + SAME);
  want('render accents keep their colour',
    rAccent <= ACCENT_WORST, 'worst accent ΔE ' + rAccent.toFixed(2) + ', want at most ' + ACCENT_WORST);
  want('render palette is full', rq.colors.length === MAX, rq.colors.length + ' colours, want ' + MAX);

  // Flat art. Nothing folds, and every chosen colour survives byte for byte.
  const flat = flatFixture();
  const fq = quantize(flat.counts, MAX);
  want('flat art reserves every colour the artist used',
    fq.reserved === flat.body.length, fq.reserved + ' reserved, want ' + flat.body.length);
  let exact = 0;
  for (const k of flat.body) {
    if (fq.colors[/** @type {number} */ (fq.assign.get(k))] === k) exact++;
  }
  want('flat art keeps them byte for byte', exact === flat.body.length,
    exact + ' of ' + flat.body.length + ' exact');
  want('flat art palette is full', fq.colors.length === MAX, fq.colors.length + ' colours, want ' + MAX);

  // No pressure on the palette. The fold buys nothing, so it is given back.
  const roomy = roomyFixture();
  const oq = quantize(roomy.counts, MAX_ROOMY);
  const oN = roomy.body.length;
  let oExact = 0;
  for (const k of roomy.body) {
    if (oq.colors[/** @type {number} */ (oq.assign.get(k))] === k) oExact++;
  }
  want('spare slots give indistinguishable reservations their slots back',
    oExact === oN, oExact + ' of ' + oN + ' exact');
  want('spare slots leave no colour off the palette',
    oq.colors.length === oN, oq.colors.length + ' colours, want ' + oN);
  want('spare slots reserve every colour', oq.reserved === oN,
    oq.reserved + ' reserved, want ' + oN);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; render: ' + rq.reserved + ' reserved of 40 near-neutrals, '
        + rRedundant + ' redundant slots, worst accent ΔE ' + rAccent.toFixed(1)
        + '; flat: ' + fq.reserved + '/' + flat.body.length + ' reserved exactly, 0 folded'
        + '; roomy: palette ' + oq.colors.length + ', ' + oq.reserved + ' reserved, '
        + oExact + ' of ' + oN + ' exact'
      : bad.length + ' of ' + cases + ' failed: ' + bad.join('; '),
  };
}
