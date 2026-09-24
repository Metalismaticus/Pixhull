// @ts-check
/**
 * The round trip: model -> one sheet -> back in through the ordinary slicer ->
 * the same model.
 *
 * Three things have to hold, and each of them has broken at least once while
 * this was being written:
 *
 * 1. The slicer finds exactly six drawings on our own sheet and names every
 *    one of them correctly. This is the check that would have caught the
 *    owner's six-cell truck sheet: the old `guessViews` fallback order
 *    (front, right, top, back, left, bottom) puts four of every six drawings
 *    in the wrong slots - restore it and this goes red at 24/72 named.
 * 2. The model carved from the reloaded sheet is the original voxel for voxel.
 * 3. Every face a view can see carries the same colour it had before. The trip
 *    carries silhouette and colour, not history - faces no view looks at are
 *    not promised, and are not compared.
 *
 * The shapes are the synthetic ones, never anyone's art. The wedge is here on
 * purpose even though the carve recolours its treads: the round trip has to
 * reproduce whatever the carve decided, banding and all.
 *
 * What is compared is the model the tool holds, on both sides of the trip -
 * both carves go through `fitViews`, so both meet the same placement rounding.
 * That matters for the cab: a drawing whose extent has the opposite parity to
 * the grid loses a column when it is imported at all (a carve defect filed
 * separately, measured by `edit/mirror-parity`), and it loses the same column
 * both times. The trip is exact; the import it rides on has its own arithmetic
 * to answer for, and this check must not be read as clearing it.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SourceView, fitViews } from '../../src/core/views.js';
import { detectCells, cropCell, guessViews } from '../../src/core/sheet.js';
import { packViewSheet, projectView } from '../../src/core/viewsheet.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

/**
 * Grids chosen so the content is not the whole grid: placement has to be
 * re-found on the way back in.
 *
 * The fin is not here, and that is a measured limitation rather than an
 * oversight: one voxel thick, it projects to a drawing one pixel wide, and
 * `detectCells` throws cells under `minSize` away as specks - 2 of its 6
 * drawings survive the slicer. A model one voxel thin does not survive the
 * round trip, and nothing here pretends otherwise.
 */
const CASES = [
  { name: 'cube', N: 20 },
  { name: 'step', N: 32 },
  { name: 'wedge', N: 24 },
  { name: 'cab', N: 28 },
];

/** Gutters the sheet is read back at. 1 is the dialog's default. */
const GUTTERS = [1, 2, 3];

export function run() {
  /** @type {string[]} */
  const bad = [];
  let named = 0;
  let wantNamed = 0;
  let voxels = 0;
  let missing = 0;
  let extra = 0;
  let pixels = 0;
  let recoloured = 0;

  for (const { name, N } of CASES) {
    const solid = SHAPES[name](N);
    const palette = new Palette();
    // Placed the way the app places any set of drawings, so the two carves
    // differ in one thing only: the sheet between them.
    const first = viewsOfShape(N, solid);
    fitViews(first, N);
    const { volume } = carve(first, N, palette, { mirrorMissing: false });

    const { image, cells: packed } = packViewSheet(volume, palette);

    for (const gap of GUTTERS) {
      const cells = detectCells(image, { gap });
      const guessed = guessViews(cells);
      wantNamed += packed.length;
      if (cells.length !== packed.length) {
        bad.push(name + ' gutter ' + gap + ': sliced into ' + cells.length + ', not ' + packed.length);
        continue;
      }
      /** @type {SourceView[]} */
      const back = [];
      packed.forEach((want, i) => {
        if (guessed[i] === want.name && cells[i].x === want.x && cells[i].y === want.y
          && cells[i].w === want.w && cells[i].h === want.h) named++;
        else if (bad.length < 4) bad.push(name + ' cell ' + i + ': ' + guessed[i] + ', wanted ' + want.name);
        // The slicer's own answer is what goes in, not the name we know is
        // right: a mis-named cell has to show up as a broken model, which is
        // how the user would meet it.
        back.push(new SourceView(guessed[i] ?? want.name, /** @type {any} */ (cropCell(image, cells[i]))));
      });

      const palette2 = new Palette();
      fitViews(back, N);
      const { volume: again } = carve(back, N, palette2, { mirrorMissing: false });

      for (let z = 0; z < N; z++) {
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const a = volume.get(x, y, z) ? 1 : 0;
            const b = again.get(x, y, z) ? 1 : 0;
            if (a) voxels++;
            if (a === b) continue;
            if (a) missing++; else extra++;
            if (bad.length < 4) bad.push(name + ' voxel ' + x + ',' + y + ',' + z + (a ? ' lost' : ' gained'));
          }
        }
      }

      // Colour is compared through the projections rather than face by face:
      // what the trip promises is what a view can see.
      for (const want of packed) {
        const before = projectView(volume, palette, want.name);
        const after = projectView(again, palette2, want.name);
        for (let i = 0; i < before.data.length; i += 4) {
          if (before.data[i + 3] < 128 && after.data[i + 3] < 128) continue;
          pixels++;
          if (before.data[i] === after.data[i] && before.data[i + 1] === after.data[i + 1]
            && before.data[i + 2] === after.data[i + 2] && before.data[i + 3] === after.data[i + 3]) continue;
          recoloured++;
          if (bad.length < 4) bad.push(name + '/' + want.name + ' pixel ' + (i / 4) + ' changed colour');
        }
      }
    }
  }

  const ok = missing === 0 && extra === 0 && recoloured === 0 && named === wantNamed;
  return {
    ok,
    detail: ok
      ? named + '/' + wantNamed + ' cells named, 0 of ' + voxels + ' voxels moved, 0 of '
        + pixels + ' pixels recoloured (cube, step, wedge, cab at gutters 1-3)'
      : named + '/' + wantNamed + ' named, ' + missing + ' lost, ' + extra + ' gained, '
        + recoloured + '/' + pixels + ' recoloured; ' + bad.join('; '),
  };
}
