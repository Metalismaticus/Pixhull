// @ts-check
/**
 * Start a build, watch it, and be able to give up on it.
 *
 * The page's side of the worker. One build runs at a time: asking for another
 * kills the one in flight, because the artist who changes the grid twice wants
 * the second answer and the first is now worth nothing.
 *
 * A worker is not always available. Opening `index.html` straight off the disk
 * gives a `file://` page, and browsers refuse to start a worker there; a
 * browser without module workers refuses too. Neither may lose the user their
 * build, so both fall back to carving on the main thread - the tab freezes, as
 * it always did, and the result is identical because it is the same code.
 */

import { runCarveJob } from '../core/carve-job.js';
import { Volume } from '../core/volume.js';
import { Palette } from '../core/palette.js';

/** @type {Worker|null} */
let live = null;
/**
 * How to tell the caller of the build in flight that it has been dropped.
 * @type {((err: Error) => void)|null}
 */
let abandon = null;
/** Builds are numbered so a message from a worker being torn down is ignored. */
let nextId = 1;

/**
 * The error a cancelled build rejects with. Flagged rather than matched on its
 * message: the caller has to tell "you asked for another build" apart from "the
 * build broke", and only the second one is worth telling the user about.
 */
function cancelled() {
  const err = new Error('build cancelled');
  /** @type {any} */ (err).cancelled = true;
  return err;
}

/**
 * @typedef {Object} BuildResult
 * @property {import('../core/volume.js').Volume} volume
 * @property {Palette} palette
 * @property {import('../core/carve.js').CarveStats} stats
 * @property {{buffer: ArrayBuffer, count: number}} faces
 * @property {{min: number[], max: number[]}|null} box
 * @property {boolean} onMainThread true when no worker could be used
 */

/** Stop the build in flight, if any; its promise rejects as cancelled. */
export function cancelBuild() {
  if (live) {
    live.terminate();
    live = null;
  }
  if (abandon) {
    const tell = abandon;
    abandon = null;
    tell(cancelled());
  }
}

/** @returns {Worker|null} */
function spawn() {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./carve-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * Carve here, on the main thread, and settle the caller's promise with it.
 *
 * Deliberately synchronous: there is nothing to wait for, and pretending
 * otherwise would let the caller believe the tab stayed responsive when it did
 * not.
 *
 * @param {import('../core/carve-job.js').CarveJob} job
 * @param {((fraction: number, stage: string) => void)|undefined} onProgress
 * @param {(r: BuildResult) => void} resolve
 * @param {(err: Error) => void} reject
 */
function carveHere(job, onProgress, resolve, reject) {
  try {
    const r = runCarveJob(job, onProgress);
    resolve({
      volume: Volume.unpack(r.volume),
      palette: Palette.fromSnapshot(r.palette),
      stats: r.stats,
      faces: r.faces,
      box: r.box,
      onMainThread: true,
    });
  } catch (err) {
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * @param {import('../core/carve-job.js').CarveJob} job
 * @param {(fraction: number, stage: string) => void} [onProgress]
 * @returns {Promise<BuildResult>}
 */
export function startBuild(job, onProgress) {
  cancelBuild();
  const id = nextId++;
  const worker = spawn();

  if (!worker) {
    return new Promise((resolve, reject) => carveHere(job, onProgress, resolve, reject));
  }

  live = worker;
  return new Promise((resolve, reject) => {
    abandon = reject;
    // A worker that never said anything never ran. `new Worker` succeeds in a
    // browser without module workers - the module only fails later, on its own
    // `import` - so this is the first moment the page can know, and the answer
    // has to be the carve, not a failed build.
    let spoke = false;
    worker.onmessage = (e) => {
      const msg = e.data;
      // A build the page has already abandoned; its worker is on its way out.
      if (msg.id !== id || live !== worker) return;
      spoke = true;
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction, msg.stage);
        return;
      }
      live = null;
      abandon = null;
      worker.terminate();
      if (msg.type === 'error') {
        reject(new Error(msg.message));
        return;
      }
      resolve({
        volume: Volume.unpack(msg.volume),
        palette: Palette.fromSnapshot(msg.palette),
        stats: msg.stats,
        faces: msg.faces,
        box: msg.box,
        onMainThread: false,
      });
    };
    worker.onerror = (e) => {
      if (live !== worker) return;
      live = null;
      abandon = null;
      worker.terminate();
      // Broke mid-build: the carve had begun somewhere, so this is a real
      // failure and the caller should say so. Broke before it spoke: the
      // module never loaded, and the user still gets their model here.
      if (spoke) {
        reject(new Error(e.message || 'worker failed'));
        return;
      }
      carveHere(job, onProgress, resolve, reject);
    };
    worker.postMessage({ ...job, id });
  });
}
