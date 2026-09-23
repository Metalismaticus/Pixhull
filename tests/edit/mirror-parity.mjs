// @ts-check
/**
 * Mirrored edits land on the model's own mirror image, not half a voxel off it.
 *
 * `mirrorX` reflects an edit about the grid's centre - `vol.nx - 1 - x`
 * (`src/edit/tools.js`) - while the drawing is put on the grid by `autoPlace`,
 * which centres it with a rounding (`src/core/views.js`). If those two centres
 * ever disagreed, every edit made with "mirror across X" on would land one
 * voxel away from the part it was meant to copy, and only on models whose width
 * has the opposite parity to the grid, which is why it would be reported as
 * "sometimes the mirror is off by one" rather than as a plain bug.
 *
 * So the sweep below separates the two parities deliberately: grids of 20, 21,
 * 32 and 33 cells against drawings 8, 9, 10 and 11 pixels wide, sixteen
 * combinations, each carved into a box and then painted on its leftmost column
 * with symmetry on. The check is that the mirrored stroke painted the column at
 * the far end of the model - the voxel `minX + maxX - x`, worked out from what
 * the carve actually produced rather than from what was drawn.
 *
 * Red without the fix: none needed - this passes today, and it is here to pin
 * the agreement down. Change `mirrorX` to `vol.nx - x` and all 16 cases fail.
 *
 * Two numbers the sweep turned up that are NOT this check's subject and are
 * deliberately only reported (they belong to the carve, not to editing):
 *
 * - A drawing whose width has the opposite parity to the grid loses one whole
 *   column: 9 pixels drawn come back as 8 on a grid of 32. `autoPlace` rounds
 *   the half-cell gap the same way for every view, but the back view's u axis
 *   runs the other way (`N - 1 - u`), so front and back land one cell apart and
 *   their intersection is a column narrower than either.
 * - When the front and back drawings disagree about the width by an odd number
 *   of pixels, the carved model does sit half a voxel off the grid centre, and
 *   there the mirrored edit really does land one voxel out.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SourceView } from '../../src/core/views.js';
import { applyTool } from '../../src/edit/tools.js';
import { makeFlat } from '../fixtures.mjs';

/** Grid sizes: two even, two odd. */
const GRIDS = [20, 21, 32, 33];

/** Drawn widths: two even, two odd, so every parity pairing is covered. */
const WIDTHS = [8, 9, 10, 11];

const COLOUR = [200, 60, 60];

/** Colour the mirrored stroke paints with; any index the box does not wear. */
const MARK = 250;

/**
 * A box `w` wide, `h` tall and `d` deep, drawn as six flat silhouettes and put
 * on the grid the way imported art is - by `autoPlace`, rounding and all.
 *
 * @param {number} N grid size
 * @param {number} wFront @param {number} wBack @param {number} h @param {number} d
 */
function boxModel(N, wFront, wBack, h, d) {
  const images = {
    front: makeFlat(wFront, h, COLOUR),
    back: makeFlat(wBack, h, COLOUR),
    right: makeFlat(d, h, COLOUR),
    left: makeFlat(d, h, COLOUR),
    top: makeFlat(Math.max(wFront, wBack), d, COLOUR),
    bottom: makeFlat(Math.max(wFront, wBack), d, COLOUR),
  };
  const views = [];
  for (const [name, image] of Object.entries(images)) {
    const view = new SourceView(name, image);
    // The fixture draws each view already square with the others; the solvers
    // must not turn them. Placement is left to autoPlace on purpose - it is
    // the rounding under test.
    view.orientLocked = true;
    view.autoPlace(N, 1);
    views.push(view);
  }
  return carve(views, N, new Palette(), { mirrorMissing: false }).volume;
}

/**
 * Paint the leftmost column of the model with symmetry on and report where the
 * mirrored half of that edit landed.
 *
 * @param {import('../../src/core/volume.js').Volume} vol
 * @returns {{width: number, off: number, painted: boolean} | null}
 */
function mirrorOffset(vol) {
  let minX = Infinity;
  let maxX = -1;
  vol.forEachSolid((x) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  });
  if (maxX < 0) return null;

  /** @type {{x: number, y: number, z: number, face: number} | null} */
  let seed = null;
  // The -X face of some voxel in the leftmost column: what a stroke on the
  // model's left flank would hit.
  vol.forEachSolid((x, y, z) => {
    if (seed === null && x === minX) seed = { x, y, z, face: 1 };
  });
  if (seed === null) return null;

  applyTool(vol, seed, { tool: 'paint', color: MARK, faceOnly: true, symmetryX: true });

  const want = minX + maxX - seed.x;
  // Where the mark actually ended up: the row is walked rather than the
  // formula trusted, so a failure says where the paint went, not where the
  // check assumed it would go.
  let got = -1;
  for (let x = 0; x < vol.nx; x++) {
    if (!vol.get(x, seed.y, seed.z)) continue;
    // The mirrored face points +X, the opposite way from the one that was hit.
    if (vol.getFace(x, seed.y, seed.z, 0) === MARK) { got = x; break; }
  }

  return { width: maxX - minX + 1, off: got < 0 ? NaN : got - want, painted: got === want };
}

export function run() {
  let cases = 0;
  let wrong = 0;
  let lostColumn = 0;
  /** @type {string | null} */
  let first = null;

  for (const N of GRIDS) {
    for (const W of WIDTHS) {
      const vol = boxModel(N, W, W, 6, 6);
      const m = mirrorOffset(vol);
      if (m === null) return { ok: false, detail: 'grid ' + N + ', width ' + W + ': carved nothing' };

      cases++;
      if (W - m.width !== 0) lostColumn++;
      if (!m.painted) {
        wrong++;
        if (!first) {
          first = 'grid ' + N + ', drawn ' + W + ': '
            + (Number.isNaN(m.off) ? 'nothing painted on the far side' : 'mirror off by ' + m.off);
        }
      }
    }
  }

  // Reported, not judged: the one shape where the mirror genuinely is off. See
  // the header - it is the carve's centring, and it is filed separately.
  const odd = mirrorOffset(boxModel(32, 9, 12, 6, 6));

  const detail = (cases - wrong) + '/' + cases + ' mirrored edits land on the model'
    + ' (grids 20/21/32/33 x widths 8/9/10/11)'
    + '; carve drops a column in ' + lostColumn + '/' + cases + ' of them'
    + '; front and back drawn 3 px apart: mirror off by ' + (odd === null ? 'n/a' : odd.off)
    + (first ? '; first bad: ' + first : '');

  return { ok: wrong === 0, detail };
}
