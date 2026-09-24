// @ts-check
/**
 * A browser that cannot run the worker still gets its model.
 *
 * `startBuild` has two ways of finding that out, and both have to end in the
 * same place - the carve on the main thread, with `onMainThread: true` - because
 * a build that rejects is a build the user does not get at all
 * (`src/main.js`, `status.buildFailed`):
 *
 * - no `Worker` at all, or a constructor that throws, which is `file://`;
 * - a `Worker` that constructs and then never runs the module, which is a
 *   browser without module workers (Firefox before 114, Safari before 15 - both
 *   have WebGL2, so both reach this code). Nothing is thrown there: the module
 *   fails on its own `import` and the page hears only `onerror`.
 *
 * The model is compared against a plain `carve()` of the same drawings voxel by
 * voxel and face byte by face byte, since "did not reject" is not the claim -
 * the claim is that the fallback is the same build.
 *
 * Red without the fix, measured 2026-09-24: with `onerror` fired before any
 * message, `startBuild` rejected instead of falling back - "REJECTED instead of
 * falling back: SyntaxError: import declarations may only appear at top level of
 * a module". The first case was green already and stays as the guard on the path
 * `file://` takes.
 *
 * `onerror` after the worker has spoken is deliberately left rejecting: the
 * carve had begun somewhere, so it is a real failure and worth telling the user
 * about. That case is checked here too, so a fallback that swallowed every
 * worker error would not pass.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { startBuild } from '../../src/ui/build-task.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 24;

/** @returns {import('../../src/core/carve-job.js').CarveJob} */
function makeJob() {
  return {
    views: viewsOfShape(N, SHAPES.cab(N)).map((v) => v.snapshot()),
    N,
    mirrorMissing: false,
  };
}

/**
 * A `Worker` that constructs and then fails, the way a module worker fails in a
 * browser that has no module workers: the handlers are assigned after the
 * constructor returns, so the failure has to arrive later than this tick.
 *
 * @param {{afterSpeaking?: boolean}} [opts] speak one progress message first
 */
function brokenWorker(opts = {}) {
  return class {
    constructor() {
      /** @type {((e: any) => void)|null} */
      this.onmessage = null;
      /** @type {((e: any) => void)|null} */
      this.onerror = null;
      this.id = 0;
      this.dead = false;
    }
    /** @param {any} msg */
    postMessage(msg) {
      this.id = msg.id;
      setTimeout(() => {
        if (this.dead) return;
        if (opts.afterSpeaking) {
          this.onmessage?.({ data: { id: this.id, type: 'progress', fraction: 0.1, stage: 'sample' } });
        }
        this.onerror?.({
          message: 'import declarations may only appear at top level of a module',
        });
      }, 0);
    }
    terminate() { this.dead = true; }
  };
}

/**
 * Every voxel and every face byte of the build against a plain carve.
 *
 * @param {import('../../src/core/volume.js').Volume} got
 * @param {import('../../src/core/volume.js').Volume} want
 */
function differences(got, want) {
  let voxels = 0;
  let faces = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const was = want.get(x, y, z);
        if (was !== got.get(x, y, z)) voxels++;
        if (!was) continue;
        for (let d = 0; d < 6; d++) {
          if (want.getFace(x, y, z, d) !== got.getFace(x, y, z, d)) faces++;
        }
      }
    }
  }
  return { voxels, faces };
}

export async function run() {
  const reference = carve(viewsOfShape(N, SHAPES.cab(N)), N, new Palette(), { mirrorMissing: false });

  /** @type {string[]} */
  const bad = [];
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'Worker');
  const was = /** @type {any} */ (globalThis).Worker;

  /**
   * @param {string} label
   * @param {any} WorkerImpl what the page should find as `Worker`, or undefined
   * @param {boolean} wantFallback
   */
  async function attempt(label, WorkerImpl, wantFallback) {
    if (WorkerImpl === undefined) delete /** @type {any} */ (globalThis).Worker;
    else /** @type {any} */ (globalThis).Worker = WorkerImpl;
    try {
      const built = await startBuild(makeJob());
      if (!wantFallback) {
        bad.push(label + ': resolved where the build really failed');
        return;
      }
      if (built.onMainThread !== true) bad.push(label + ': onMainThread is ' + built.onMainThread);
      const d = differences(built.volume, reference.volume);
      if (d.voxels > 0) bad.push(label + ': ' + d.voxels + ' voxels differ');
      if (d.faces > 0) bad.push(label + ': ' + d.faces + ' face bytes differ');
      if (built.faces.count !== reference.volume.buildFaceInstances().count) {
        bad.push(label + ': ' + built.faces.count + ' faces against '
          + reference.volume.buildFaceInstances().count);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (wantFallback) bad.push(label + ': REJECTED instead of falling back: ' + msg);
    }
  }

  try {
    await attempt('no Worker', undefined, true);
    await attempt('Worker that fails on import', brokenWorker(), true);
    await attempt('Worker that fails mid-build', brokenWorker({ afterSpeaking: true }), false);
  } finally {
    if (had) /** @type {any} */ (globalThis).Worker = was;
    else delete /** @type {any} */ (globalThis).Worker;
  }

  return {
    ok: bad.length === 0,
    detail: reference.volume.solidCount + ' voxels, 3 cases, '
      + (bad.length === 0 ? '0 differences' : bad.join('; ')),
  };
}
