// @ts-check
/**
 * A volume that has crossed a worker boundary is the same volume.
 *
 * `Volume.pack()` / `Volume.unpack()` exist only so a build can happen off the
 * main thread, and they are the one place in the product where every face byte
 * is copied by hand. A byte lost here is not a slow repaint: it is a hole in
 * the model, a wrong colour in an export, and a lie in every undo step stored
 * against it (`CLAUDE.md`, "Байт грани — источник истины"). So this compares
 * the two volumes byte for byte rather than by any summary of them.
 *
 * Red without the fix, measured 2026-09-24 in a copy of the repository:
 *
 * - dropping the copy into `faces`: 12834 face bytes differ, and the instance
 *   buffer the page draws differs by its eighth byte;
 * - packing `solid` at offset 0 instead of per chunk: 91280 voxels differ;
 * - copying the per-chunk counts but not `solidCount`: 0 against 91440.
 *
 * The fixture is the cab, because it is the shape with painted slopes: a cube
 * would leave most of its chunks unpainted and hide a mistake in the face
 * arrays.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 48;

export function run() {
  const views = viewsOfShape(N, SHAPES.cab(N));
  const { volume } = carve(views, N, new Palette(), { mirrorMissing: false });

  const packed = volume.pack();
  const copy = Volume.unpack(packed);

  let voxels = 0;
  let faceBytes = 0;
  let solidMismatch = 0;
  let faceMismatch = 0;

  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const was = volume.get(x, y, z);
        if (was !== copy.get(x, y, z)) solidMismatch++;
        if (!was) continue;
        voxels++;
        for (let d = 0; d < 6; d++) {
          faceBytes++;
          if (volume.getFace(x, y, z, d) !== copy.getFace(x, y, z, d)) faceMismatch++;
        }
      }
    }
  }

  /** @type {string[]} */
  const bad = [];
  if (solidMismatch > 0) bad.push(solidMismatch + ' voxels differ');
  if (faceMismatch > 0) bad.push(faceMismatch + ' face bytes differ');
  if (copy.solidCount !== volume.solidCount) {
    bad.push('count ' + copy.solidCount + ' against ' + volume.solidCount);
  }
  // An unpacked volume carries the geometry it came with, so asking the renderer
  // to rebuild every chunk of it would undo the point of the transfer.
  if (copy.dirty.size !== 0) bad.push(copy.dirty.size + ' chunks arrived dirty');
  // The instances are what the page actually draws; equal volumes that disagree
  // here would still show the wrong model.
  const a = new Uint8Array(volume.buildFaceInstances().buffer);
  const b = new Uint8Array(copy.buildFaceInstances().buffer);
  if (a.length !== b.length) bad.push('instances ' + b.length + ' bytes against ' + a.length);
  else for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { bad.push('instance byte ' + i + ' differs'); break; }
  }

  return {
    ok: bad.length === 0,
    detail: voxels + ' voxels, ' + faceBytes + ' face bytes, '
      + (bad.length === 0 ? '0 differences' : bad.join('; ')),
  };
}
