// @ts-check
/**
 * A build still in flight must not land on top of a project the user loaded.
 *
 * Since the build moved off the main thread the tab answers while it runs, so
 * the Load button is reachable mid-build - and that opened a new way to lose
 * work silently, the very thing the rebuild guard exists to prevent
 * (`tests/edit/rebuild-guard.mjs`). Order: a 512 build is running, the user
 * loads a project that carries voxels, the file's model and palette go up, and
 * then the build finishes and replaces `state.volume`, `state.palette` and the
 * undo history without a word - after `mayDiscardEdits()` had already asked and
 * been told no.
 *
 * Two halves, because `src/main.js` needs a DOM and a WebGL2 context and cannot
 * be imported in Node (`docs/TESTING.md`, "Чего проверки не видят"):
 *
 * 1. the mechanism, measured: `cancelBuild()` on a build in flight makes its
 *    promise reject as `cancelled`, so the continuation that writes the result
 *    into the app never runs - not even when the worker delivers a complete,
 *    genuine result afterwards. This half was green before the fix; it is the
 *    guard on the tool the fix uses;
 * 2. the call site, read from the source of `loadProject()`: the branch that
 *    restores saved voxels has to drop the build in flight before it replaces
 *    the model, or refuse to load while one runs. This half is the one that was
 *    red: on the code before the fix the branch replaced `state.volume` with
 *    nothing standing between it and the build.
 *
 * Red without the fix, measured 2026-09-24: "loadProject restores voxels
 * without dropping the build in flight". Removing the three lines of
 * `dropBuild()` turns it red again from the other end: "dropBuild() does not
 * clear state.building" / "does not hide the progress bar".
 */

import { readFile } from 'node:fs/promises';
import { runCarveJob } from '../../src/core/carve-job.js';
import { startBuild, cancelBuild } from '../../src/ui/build-task.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 20;

/** @returns {import('../../src/core/carve-job.js').CarveJob} */
function makeJob() {
  return {
    views: viewsOfShape(N, SHAPES.cab(N)).map((v) => v.snapshot()),
    N,
    mirrorMissing: false,
  };
}

/**
 * A worker that reports progress and finishes later, with a real result.
 *
 * The result is a genuine `runCarveJob` answer rather than a stub, so the
 * "cancelled" path is not being confirmed by a message the page would have
 * rejected anyway.
 */
function slowWorker() {
  return class {
    constructor() {
      /** @type {((e: any) => void)|null} */
      this.onmessage = null;
      /** @type {((e: any) => void)|null} */
      this.onerror = null;
      this.dead = false;
      /** @type {(() => void)|null} */
      this.finish = null;
      live.push(this);
    }
    /** @param {any} msg */
    postMessage(msg) {
      const id = msg.id;
      this.onmessage?.({ data: { id, type: 'progress', fraction: 0.3, stage: 'sample' } });
      this.finish = () => {
        const r = runCarveJob({ views: msg.views, N: msg.N, mirrorMissing: msg.mirrorMissing });
        this.onmessage?.({
          data: {
            id,
            type: 'done',
            volume: r.volume,
            faces: r.faces,
            palette: r.palette,
            stats: r.stats,
            box: r.box,
          },
        });
      };
    }
    terminate() { this.dead = true; }
  };
}

/** @type {any[]} */
const live = [];

/** Both the sequence and the source check report into this. @type {string[]} */
const bad = [];

/** The mechanism: a cancelled build never reaches the code that applies it. */
async function checkSequence() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'Worker');
  const was = /** @type {any} */ (globalThis).Worker;
  /** @type {any} */ (globalThis).Worker = slowWorker();

  // What is on screen, in the only two ways that matter here: which model the
  // app is showing, and whether the undo history was thrown away.
  const screen = { model: 'nothing', historyClears: 0 };
  let progress = 0;

  try {
    // The build the artist started. Shaped like `build()` in `src/main.js`: the
    // result is applied after the await, and a `cancelled` rejection is the one
    // rejection that says nothing and changes nothing.
    const flight = startBuild(makeJob(), () => { progress++; });
    const applying = (async () => {
      /** @type {import('../../src/ui/build-task.js').BuildResult} */
      let built;
      try {
        built = await flight;
      } catch (err) {
        if (err instanceof Error && /** @type {any} */ (err).cancelled) return;
        bad.push('the build failed for a reason other than cancellation: ' + err);
        return;
      }
      if (built.volume.solidCount === 0) bad.push('the fixture carved nothing');
      screen.model = 'build';
      screen.historyClears++;
    })();

    if (progress !== 1) bad.push('the build reported ' + progress + ' progress steps, want 1');
    if (live.length !== 1) bad.push(live.length + ' workers started, want 1');

    // The user loads a project carrying voxels. This is `loadProject()`: drop
    // the build, then put the file up.
    cancelBuild();
    screen.model = 'file';

    await applying;
    // The abandoned worker finishes anyway - terminate() is not instant in a
    // browser, and the page must survive a message from a worker on its way out.
    for (const w of live) w.finish?.();
    await applying;
    await new Promise((r) => setTimeout(r, 0));

    if (screen.model !== 'file') {
      bad.push('the build replaced the loaded project: model is ' + screen.model);
    }
    if (screen.historyClears !== 0) {
      bad.push('the build cleared the history of the loaded project ('
        + screen.historyClears + ' times)');
    }
    if (!live[0]?.dead) bad.push('the abandoned worker was left running');
  } finally {
    cancelBuild();
    if (had) /** @type {any} */ (globalThis).Worker = was;
    else delete /** @type {any} */ (globalThis).Worker;
  }
}

/**
 * The body of a function or block, from its opening brace to the matching one.
 *
 * @param {string} src
 * @param {string} head text just before the `{`, e.g. `function dropBuild()`
 * @returns {string|null}
 */
function blockAfter(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const open = src.indexOf('{', at + head.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The call site, read from `src/main.js`. */
async function checkCallSite() {
  const src = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');

  const load = blockAfter(src, 'async function loadProject(file)');
  if (load === null) {
    bad.push('loadProject() not found in src/main.js - this check needs rewriting');
    return;
  }
  const restore = blockAfter(load, 'if (data.volume && data.palette)');
  if (restore === null) {
    bad.push('the saved-voxels branch of loadProject() not found - this check needs rewriting');
    return;
  }
  const replaces = restore.search(/state\.(volume|palette)\s*=/);
  if (replaces < 0) {
    bad.push('the saved-voxels branch no longer replaces the model - this check needs rewriting');
    return;
  }
  const before = restore.slice(0, replaces);
  // Either answer to the race is accepted: drop the build, or refuse to load
  // while one runs. What is not accepted is replacing the model beside it.
  const drops = /\bdropBuild\(\)|\bcancelBuild\(\)/.test(before);
  const refuses = /\bstate\.building\b/.test(before);
  if (!drops && !refuses) {
    bad.push('loadProject restores voxels without dropping the build in flight');
  }

  if (/\bdropBuild\(\)/.test(before)) {
    const drop = blockAfter(src, 'function dropBuild()');
    if (drop === null) {
      bad.push('dropBuild() is called but not defined');
    } else {
      if (!/\bcancelBuild\(\)/.test(drop)) bad.push('dropBuild() does not cancel the build');
      if (!/state\.building\s*=\s*false/.test(drop)) bad.push('dropBuild() does not clear state.building');
      if (!/showBuildProgress\(null\)/.test(drop)) bad.push('dropBuild() does not hide the progress bar');
    }
  }
}

export async function run() {
  await checkSequence();
  await checkCallSite();
  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '1 sequence (build cancelled mid-flight, 0 of 2 app writes landed) + 1 call site read'
      : bad.join('; '),
  };
}
