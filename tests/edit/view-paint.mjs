// @ts-check
/**
 * Painting a drawing inside the app: what the tools touch, what undo gives
 * back, and what the model does about it.
 *
 * The screen is specified in
 * `docs/specs/2026-09-24-3-view-editing-2d-3d.md`. `src/main.js` cannot be
 * imported in Node (`docs/TESTING.md`), so what is measured here is the part
 * that carries the behaviour: `src/edit/draw2d.js`, the new `view` entry in
 * `src/edit/history.js`, the chunked projection in `src/core/viewsheet.js`,
 * and - end to end - a drawing painted and then carved.
 *
 * Six promises, each of which broke at least once while this was written:
 *
 * 1. A brush covers the square it promises and no more, clipped at the edge.
 * 2. Transparent is a colour the fill can flood, and one region whatever RGB
 *    the invisible pixels happen to carry.
 * 3. A transparent pixel has no colour to pick; black would be a colour that
 *    was never in the drawing.
 * 4. One stroke is one undo step, and undo returns the drawing byte for byte.
 * 5. **A stroke on a drawing does not make `hasEdits` true** - but it does make
 *    `hasViewEdits` true. This is the whole of section 4.4 and its other half:
 *    the rebuild is what the drawing is waiting for, so asking "you will lose
 *    your hand edits" before carving the pixels just painted would be the guard
 *    fighting its own purpose - while Demo, Clear, a project file and a new PNG
 *    in the slot *destroy* the drawing, and those must ask.
 * 6. The drawing reaches the model - erase a block of the projected front view,
 *    carve again, and exactly that tube of voxels is gone.
 *
 * Red without the fix, case by case:
 *   - `ALPHA_THRESHOLD` raised so a fill on empty space matches nothing: case 2
 *     falls to 0 of 64.
 *   - `pickAt` returning packed black instead of null: case 3 fails.
 *   - `hasEdits` back to `cursor > 0`: case 5 reports true and fails.
 *   - `hasViewEdits` always false (the five destructive paths ask nothing):
 *     case 5 fails on `guard.viewsAtRisk`.
 *   - `#writeView` matching a drawing by `width`/`height` instead of by the
 *     image itself: case 4's `undo.otherImage` writes 4 bytes into a drawing the
 *     stroke never touched, and `undo.otherImageIntact` falls to false.
 *   - `projectView` walking rows itself instead of through `projectViewRows`:
 *     the two answers stop being the same array.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SourceView, fitViews } from '../../src/core/views.js';
import { projectView, projectViewRows } from '../../src/core/viewsheet.js';
import { Volume } from '../../src/core/volume.js';
import { History } from '../../src/edit/history.js';
import {
  ViewStroke, blankSheet, paintAt, eraseAt, pickAt, fillAt,
} from '../../src/edit/draw2d.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const RED = 0xd94f3a;
const BLUE = 0x3a6fd9;
const GREEN = 0x4fd93a;

/** @param {{data: Uint8ClampedArray}} a @param {{data: Uint8ClampedArray}} b */
function sameBytes(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** @param {{width: number, height: number, data: Uint8ClampedArray}} img */
function opaqueCount(img) {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 128) n++;
  return n;
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {number|boolean|null} got @param {number|boolean|null} want */
  const eq = (name, got, want) => {
    cases++;
    if (got !== want) bad.push(name + '=' + got + ' want ' + want);
  };

  // ---------------------------------------------------- 1. what a brush covers
  const sheet = blankSheet(16);
  eq('blank.size', sheet.width * sheet.height, 256);
  eq('blank.opaque', opaqueCount(sheet), 0);

  eq('brush.r2', paintAt(sheet, 8, 8, 2, RED), 25);
  eq('brush.again', paintAt(sheet, 8, 8, 2, RED), 0);
  // Clipped at the corner: a quarter of the square is off the sheet.
  eq('brush.corner', paintAt(sheet, 0, 0, 2, BLUE), 9);
  eq('brush.outside', paintAt(sheet, -1, 8, 0, BLUE), 0);
  eq('erase.r1', eraseAt(sheet, 8, 8, 1), 9);
  eq('erase.again', eraseAt(sheet, 8, 8, 1), 0);

  // ----------------------------------------- 2. transparent is a colour to fill
  const flood = blankSheet(8);
  eq('fill.empty', fillAt(flood, 0, 0, RED).count, 64);
  eq('fill.same', fillAt(flood, 0, 0, RED).count, 0);
  for (let y = 0; y < 8; y++) paintAt(flood, 4, y, 0, BLUE);
  // The blue wall cuts the red field in two; the fill takes the left half only.
  eq('fill.split', fillAt(flood, 0, 0, GREEN).count, 32);
  eq('fill.rightUntouched', fillAt(flood, 7, 0, GREEN).count, 24);
  // A transparent field whose invisible pixels carry different RGB is still one
  // region: alpha is what "nothing is drawn here" means.
  const ragged = blankSheet(4);
  ragged.data[0] = 255; ragged.data[1] = 255; ragged.data[2] = 255; // white, alpha 0
  eq('fill.ragged', fillAt(ragged, 3, 3, RED).count, 16);

  // --------------------------------------- 3. a transparent pixel has no colour
  const pickSheet = blankSheet(4);
  eq('pick.empty', pickAt(pickSheet, 1, 1), null);
  paintAt(pickSheet, 1, 1, 0, RED);
  eq('pick.painted', pickAt(pickSheet, 1, 1), RED);
  eq('pick.outside', pickAt(pickSheet, 9, 9), null);

  // --------------------------------- 4. one stroke, one step, byte for byte back
  const drawing = blankSheet(16);
  paintAt(drawing, 2, 2, 0, BLUE);
  const original = { width: 16, height: 16, data: drawing.data.slice() };

  const history = new History();
  history.viewSource = () => drawing;
  const stroke = new ViewStroke('front', drawing);
  stroke.count += paintAt(drawing, 5, 5, 0, RED);
  stroke.count += paintAt(drawing, 6, 5, 0, RED);
  stroke.count += paintAt(drawing, 7, 6, 0, RED);
  const entry = stroke.finish();
  eq('stroke.recorded', entry !== null, true);
  if (entry) {
    eq('stroke.count', stroke.count, 3);
    // The patch is the bounding box of what moved, not the whole sheet.
    eq('stroke.rect', entry.rect.x * 1000 + entry.rect.y * 100 + entry.rect.w * 10 + entry.rect.h,
      5 * 1000 + 5 * 100 + 3 * 10 + 2);
    history.pushView(entry);
  }
  const after = { width: 16, height: 16, data: drawing.data.slice() };

  eq('stroke.steps', history.stack.length, 1);
  eq('undo.kind', history.undo(null, undefined), 'view');
  eq('undo.exact', sameBytes(drawing, original), true);
  eq('redo.kind', history.redo(null, undefined), 'view');
  eq('redo.exact', sameBytes(drawing, after), true);

  // A stroke that moved nothing is dropped rather than stacked as a no-op.
  const idle = new ViewStroke('front', drawing);
  eq('stroke.noop', idle.finish(), null);

  // The drawing a `view` entry names can be replaced whole - by a projection, a
  // blank sheet, a dropped file. Undo then refuses rather than writing into a
  // picture that is not the one the stroke was made on.
  const lost = new History();
  lost.viewSource = () => blankSheet(8);
  if (entry) lost.pushView(entry);
  eq('undo.refused', lost.undo(null, undefined), null);
  eq('undo.cursorKept', lost.cursor, 1);

  // And the replacement is usually the *same* size: empty the only slot, start
  // a blank sheet at the grid's size, press Ctrl+Z. Matching by width and
  // height would call that the same drawing and paint the fresh sheet with the
  // old stroke; the entry names the image itself, so it is refused.
  const other = blankSheet(16);
  // Painted where the recorded stroke's patch lands, so a wrong undo is visible
  // as bytes and not merely as a returned kind: the measurement that found this
  // saw 4 bytes written into a drawing the stroke never touched.
  paintAt(other, 5, 5, 0, GREEN);
  const otherBefore = other.data.slice();
  const swapped = new History();
  swapped.viewSource = () => other;
  if (entry) swapped.pushView(entry);
  eq('undo.otherImage', swapped.undo(null, undefined), null);
  eq('undo.otherImageIntact', sameBytes(other, { data: otherBefore }), true);
  eq('undo.otherCursorKept', swapped.cursor, 1);
  // The same entry still undoes into its own drawing, so the refusal is about
  // identity and not about refusing everything.
  eq('undo.ownImage', history.undo(null, undefined), 'view');
  eq('undo.ownExact', sameBytes(drawing, original), true);
  eq('redo.restore', history.redo(null, undefined), 'view');

  // ------------------------- 5. painting a drawing threatens nothing in the model
  const guard = new History();
  guard.viewSource = () => drawing;
  if (entry) guard.pushView(entry);
  eq('guard.afterDrawing', guard.hasEdits, false);
  // The other half: the five paths that destroy the drawing instead of carving
  // it ask their own question, and this is what they ask.
  eq('guard.viewsAtRisk', guard.hasViewEdits(), true);
  eq('guard.viewsByName', guard.hasViewEdits('front'), true);
  eq('guard.otherSlotSafe', guard.hasViewEdits('top'), false);
  eq('guard.empty', new History().hasViewEdits(), false);
  // Undone back to nothing is nothing left to lose - the same rule `hasEdits`
  // follows, so Demo after Ctrl+Z is silent again.
  eq('guard.undoneKind', guard.undo(null, undefined), 'view');
  eq('guard.afterUndo', guard.hasViewEdits(), false);
  eq('guard.afterRedo', guard.redo(null, undefined), 'view');
  eq('guard.redoneAtRisk', guard.hasViewEdits(), true);
  const vol = new Volume(8, 8, 8);
  guard.begin();
  guard.touch(vol, 1, 1, 1);
  vol.set(1, 1, 1, true);
  eq('guard.voxelCommitted', guard.commit(vol), true);
  eq('guard.afterVoxel', guard.hasEdits, true);

  // ------------------------------------ 6. the drawing reaches the model, exactly
  const N = 16;
  const palette = new Palette();
  const views = viewsOfShape(N, SHAPES.cube(N));
  fitViews(views, N);
  const { volume } = carve(views, N, palette, { mirrorMissing: false });
  eq('cube.voxels', volume.solidCount, N * N * N);

  // The projection is the full grid, never cropped to its content: a drawing
  // exactly N x N lands on the grid cell for cell (spec 4.3).
  const front = projectView(volume, palette, 'front');
  eq('project.width', front.width, N);
  eq('project.height', front.height, N);
  eq('project.opaque', opaqueCount(front), N * N);

  // The chunked walk the progress bar rides on is the same walk, not a second
  // implementation of it.
  const chunked = new Uint8ClampedArray(N * N * 4);
  for (let v = 0; v < N; v += 3) {
    projectViewRows(volume, palette, 'front', v, Math.min(N, v + 3), chunked);
  }
  eq('project.chunked', sameBytes({ data: chunked }, { data: front.data }), true);

  // Erase a 4x4 block from the corner of the front drawing and carve again.
  // `front`'s (u, v) is (x, N-1-y), so the hole is a square tube through z.
  const edited = { width: N, height: N, data: front.data.slice() };
  let erased = 0;
  for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) erased += eraseAt(edited, u, v, 0);
  eq('edit.pixels', erased, 16);

  const again = views.map((view) => (view.name === 'front'
    ? new SourceView('front', /** @type {any} */ (edited))
    : new SourceView(view.name, /** @type {any} */ (view.image))));
  const palette2 = new Palette();
  fitViews(again, N);
  const { volume: carved } = carve(again, N, palette2, { mirrorMissing: false });
  eq('edit.voxels', carved.solidCount, N * N * N - 4 * 4 * N);

  let wrong = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const want = !(x < 4 && y >= N - 4);
        if (carved.get(x, y, z) !== want) wrong++;
      }
    }
  }
  eq('edit.placed', wrong, 0);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; brush 25/9 of a 5x5 square, fill 64 then 32 of 64 with transparent'
        + ' as one region, one stroke one step and undo exact, undo refused into'
        + ' another drawing of the same 16x16, hasEdits false and hasViewEdits true'
        + ' after painting a drawing, carve loses exactly ' + 4 * 4 * N + ' voxels of ' + N * N * N
      : cases + ' cases, ' + bad.length + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
