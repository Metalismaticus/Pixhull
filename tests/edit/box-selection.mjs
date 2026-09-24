// @ts-check
/**
 * The box tool marks a block; the block is a thing you can look at and adjust
 * before anything happens to the model.
 *
 * This is the half of the point that Node can see. Whether the outline reads
 * on screen and whether a face is easy to grab with a mouse are questions for
 * a screenshot; whether the block is one cell deep when it is drawn, whether
 * pulling a face gives the third dimension, whether the counts under it are
 * the numbers the buttons promise, and whether one press is one undo step are
 * all arithmetic, and they are what used to be wrong.
 *
 * Red without the fix:
 *   - depth from the brush slider (the old `boxExtent(anchor, corner, brush+1,
 *     true)`): the fresh block is `brush+1` deep and sits one cell outside the
 *     face, so `depth=1` and `insideTheModel` both fail;
 *   - let `resizeExtent` past the opposite face: `neverInverts` reports a
 *     block 0 or fewer cells across;
 *   - drop the clamp in `resizeExtent`: `staysInGrid` reports a face outside
 *     the volume;
 *   - count with a plain loop and no ceiling: `hugeBlockNotCounted` reports
 *     `counted=true` after walking 2 000 001 cells;
 *   - apply on pointer-up as the tool used to: `blockOutlivesTheDrag` cannot
 *     even be written, because there is no block left to measure.
 */

import { Volume } from '../../src/core/volume.js';
import { History } from '../../src/edit/history.js';
import {
  dragExtent, resizeExtent, clampExtent, extentSize, extentCells, countBlock,
  boxFaceUnderRay, axisPointFromRay, applySelection, COUNT_LIMIT,
} from '../../src/edit/selection.js';

/** A solid cube of side `n` in the middle of a grid, every face colour 3. */
function cubeVolume(N, lo, hi) {
  const vol = new Volume(N, N, N);
  for (let z = lo; z <= hi; z++) {
    for (let y = lo; y <= hi; y++) {
      for (let x = lo; x <= hi; x++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, 3);
      }
    }
  }
  return vol;
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {*} got @param {*} want */
  const eq = (name, got, want) => {
    cases++;
    if (got !== want) bad.push(name + '=' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  };

  const N = 32;
  const dims = /** @type {[number, number, number]} */ ([N, N, N]);

  // ---- a fresh drag is a rectangle exactly one cell deep, on the face it
  // started on. The brush slider has nothing to do with it any more.
  const anchor = { x: 10, y: 10, z: 10, face: 4 }; // +Z face
  const fresh = dragExtent(anchor, [15, 17, 10], dims);
  eq('depth', extentSize(fresh)[2], 1);
  eq('width', extentSize(fresh)[0], 6);
  eq('height', extentSize(fresh)[1], 8);
  // Inside the model, not one cell out in the air: the block is a region of
  // the volume, and "fill" is one of three things it can be used for.
  eq('insideTheModel', fresh.min[2], 10);
  eq('insideTheModelMax', fresh.max[2], 10);

  // The rectangle is clamped whichever way the pointer ran off the grid.
  const off = dragExtent(anchor, [-40, 99, 10], dims);
  eq('clampLow', off.min[0], 0);
  eq('clampHigh', off.max[1], N - 1);

  // ---- pulling a face gives the third dimension, which is the whole point.
  const deeper = resizeExtent(fresh, 4, 14, dims); // +Z face out to plane 14
  eq('thirdDimension', extentSize(deeper)[2], 4);
  eq('otherTwoUntouched', extentSize(deeper)[0] + ',' + extentSize(deeper)[1], '6,8');
  const back = resizeExtent(fresh, 5, 6, dims); // -Z face back to plane 6
  eq('pullTheOtherWay', extentSize(back)[2], 5);

  // A face never passes its opposite: one cell is the smallest block.
  const crushed = resizeExtent(deeper, 5, 99, dims);
  eq('neverInverts', extentSize(crushed)[2], 1);
  const crushedMax = resizeExtent(deeper, 4, -99, dims);
  eq('neverInvertsMax', extentSize(crushedMax)[2], 1);

  // And never leaves the grid.
  const pushed = resizeExtent(fresh, 4, 9999, dims);
  eq('staysInGrid', pushed.max[2], N - 1);
  const pulled = resizeExtent(fresh, 5, -9999, dims);
  eq('staysInGridMin', pulled.min[2], 0);

  // ---- which face a ray arms: always the one turned towards the camera.
  const block = clampExtent({ min: [8, 8, 8], max: [12, 12, 12] }, dims);
  /** @type {Array<[[number, number, number], number]>} */
  const looks = [
    [[1, 0, 0], 1], // travelling +X enters through the -X face
    [[-1, 0, 0], 0],
    [[0, 1, 0], 3],
    [[0, -1, 0], 2],
    [[0, 0, 1], 5],
    [[0, 0, -1], 4],
  ];
  for (const [dir, want] of looks) {
    const origin = /** @type {[number, number, number]} */ ([
      10.5 - dir[0] * 100, 10.5 - dir[1] * 100, 10.5 - dir[2] * 100,
    ]);
    eq('arm' + dir.join(''), boxFaceUnderRay(block, origin, dir), want);
  }
  // A ray that goes past the block arms nothing, so a press there starts a new
  // block instead of dragging a face that is not under the cursor.
  eq('missesTheBlock', boxFaceUnderRay(block, [100, 100, 100], [0, 0, 1]), null);

  // Where a dragged face should go: the point on its axis nearest the ray.
  const coord = axisPointFromRay([0, 0, 100], [0, 0, -1], [0, 0, 0], 2);
  eq('axisAlongView', coord, null); // looking straight down the axis says so
  const side = axisPointFromRay([100, 0, 7], [-1, 0, 0], [0, 0, 0], 2);
  eq('axisAcrossView', side === null ? null : Math.round(side), 7);

  // ---- the counts the panel prints and the buttons promise.
  const vol = cubeVolume(N, 8, 15); // a solid 8-cube from 8 to 15
  const half = { min: /** @type {[number,number,number]} */ ([6, 8, 8]),
    max: /** @type {[number,number,number]} */ ([9, 9, 9]) };
  const counts = countBlock(vol, half);
  eq('cells', counts.cells, extentCells(half));
  eq('solid', counts.solid, 8); // x 8..9 of the cube, 2 x 2 x 2
  eq('empty', counts.empty, counts.cells - 8);
  eq('counted', counts.counted, true);

  // Past the ceiling the two numbers are unknown, not nought.
  const bigN = 256;
  const big = new Volume(bigN, bigN, bigN);
  const huge = countBlock(big, { min: [0, 0, 0], max: [bigN - 1, bigN - 1, bigN - 1] });
  eq('hugeCells', huge.cells, bigN ** 3);
  eq('hugeOverLimit', huge.cells > COUNT_LIMIT, true);
  eq('hugeBlockNotCounted', huge.counted, false);
  eq('hugeSaysNothing', huge.solid, 0);

  // ---- the three actions, each one history entry, each honest about its
  // number, and the block itself untouched by any of them.
  const h = new History();

  const fillVol = cubeVolume(N, 8, 15);
  const before = countBlock(fillVol, half);
  h.begin();
  const filled = applySelection(fillVol, half, 'fill', { color: 5, history: h });
  eq('fillCount', filled.voxels, before.empty);
  eq('fillCommitted', h.commit(fillVol), true);
  eq('fillSolidNow', countBlock(fillVol, half).empty, 0);
  eq('fillOneStep', h.undo(fillVol, null), 'voxels');
  eq('fillUndone', countBlock(fillVol, half).solid, before.solid);

  const cutVol = cubeVolume(N, 8, 15);
  const h2 = new History();
  h2.begin();
  const cut = applySelection(cutVol, half, 'delete', { color: 5, history: h2 });
  eq('deleteCount', cut.voxels, before.solid);
  eq('deleteEmptyNow', countBlock(cutVol, half).solid, 0);
  eq('deleteCommitted', h2.commit(cutVol), true);
  eq('deleteOneStep', h2.undo(cutVol, null), 'voxels');
  eq('deleteUndone', countBlock(cutVol, half).solid, before.solid);

  const paintVol = cubeVolume(N, 8, 15);
  const h3 = new History();
  h3.begin();
  const painted = applySelection(paintVol, half, 'paint', { color: 7, history: h3 });
  // Every solid cell in the block wore colour 3 on all six faces.
  eq('paintVoxels', painted.voxels, before.solid);
  eq('paintFaces', painted.faces, before.solid * 6);
  eq('paintKeepsGeometry', countBlock(paintVol, half).solid, before.solid);
  eq('paintLanded', paintVol.getFace(8, 8, 8, 0), 7);
  eq('paintCommitted', h3.commit(paintVol), true);
  eq('paintOneStep', h3.undo(paintVol, null), 'voxels');
  eq('paintUndone', paintVol.getFace(8, 8, 8, 0), 3);
  // Painting the same colour twice changes nothing and says so, rather than
  // writing an undo step that undoes nothing.
  h3.begin();
  const again = applySelection(paintVol, half, 'paint', { color: 3, history: h3 });
  eq('paintNothing', again.faces, 0);
  eq('paintNothingCommitted', h3.commit(paintVol), false);

  // ---- and the block survives all of it: the extent object the caller holds
  // is never rewritten by an action, which is what lets "delete" be followed
  // by "delete one cell deeper".
  eq('blockOutlivesTheDrag', half.min.join(',') + '/' + half.max.join(','), '6,8,8/9,9,9');

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; fresh block 1 cell deep, face drag gives depth ' +
        extentSize(deeper)[2] + ', ' + before.solid + ' solid / ' + before.empty +
        ' empty counted, ' + (bigN ** 3) + ' cells not counted'
      : bad.length + ' of ' + cases + ' wrong: ' + bad.slice(0, 6).join('; '),
  };
}
