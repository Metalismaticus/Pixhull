// @ts-check
/**
 * The build says how far it has got, often enough and in one direction.
 *
 * A build off the main thread is only half the point of the queue item: an
 * artist watching a 512 grid has to see it moving, or a responsive tab just
 * means a tab that looks idle for eleven seconds. What the page can show is
 * exactly what `onProgress` reports, so this checks the report rather than the
 * bar (the bar itself is CSS width and only an eye can confirm it):
 *
 * - it never goes backwards. The gap-filling stage can revise its own estimate
 *   downwards, because the queue it is walking grows while it walks it, and a
 *   bar that slides back reads as a bug. Worth saying plainly: this fixture is
 *   too small to make that happen - removing the high-water mark in
 *   `carve.js` leaves this check green - so the assertion is a guard for later,
 *   not a measurement;
 * - it ends at exactly 1, so the bar is never left short of the end;
 * - every stage is named, because the status line prints the stage;
 * - no single step is a big jump, and no stretch of time passes without a
 *   report - either would be a bar that sits still and then leaps.
 *
 * Red without the fix, measured 2026-09-24: with the reports inside the loops
 * removed and only the stage boundaries left, 30 reports, worst step 20% of the
 * bar and worst silence 32% of the build; with `carve()` ignoring `onProgress`
 * altogether, 4 reports, 80% and 88%, and six of the seven stages never named.
 */

import { runCarveJob } from '../../src/core/carve-job.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

/**
 * Chosen, not measured: a bar that jumps an eighth of its width at a time, or
 * stands still for a fifth of the wait, is the thing being ruled out. The
 * measured figures on this bench at N=64 are 10% and 12% - the 10% is the step
 * across `buildFaceInstances`, which is one indivisible call.
 */
const MAX_STEP = 0.125;
const MAX_SILENCE = 0.2;

/** The stages `carve.js` and `carve-job.js` report, in the order they run. */
const STAGES = ['sample', 'intersect', 'field', 'paint', 'slopes', 'infer', 'geometry'];

const N = 64;

export function run() {
  /** @type {number[]} */
  const fractions = [];
  /** @type {number[]} */
  const times = [];
  /** @type {Set<string>} */
  const stages = new Set();

  const views = viewsOfShape(N, SHAPES.cab(N));
  const t0 = performance.now();
  runCarveJob({ views: views.map((v) => v.snapshot()), N, mirrorMissing: false }, (fraction, stage) => {
    fractions.push(fraction);
    times.push(performance.now() - t0);
    stages.add(stage);
  });
  const total = performance.now() - t0;

  /** @type {string[]} */
  const bad = [];
  if (fractions.length === 0) bad.push('no progress reported');

  let backwards = 0;
  let worstStep = 0;
  let previous = 0;
  for (const f of fractions) {
    if (f < previous - 1e-9) backwards++;
    if (f - previous > worstStep) worstStep = f - previous;
    previous = Math.max(previous, f);
  }
  if (backwards > 0) bad.push(backwards + ' reports went backwards');
  if (worstStep > MAX_STEP) bad.push('worst step ' + (worstStep * 100).toFixed(0) + '% of the bar');
  if (fractions[fractions.length - 1] !== 1) {
    bad.push('ends at ' + (fractions[fractions.length - 1] ?? 0));
  }
  if (fractions.some((f) => f < 0 || f > 1)) bad.push('a report fell outside 0..1');

  let worstSilence = 0;
  let last = 0;
  for (const ms of [...times, total]) {
    if (ms - last > worstSilence) worstSilence = ms - last;
    last = ms;
  }
  if (worstSilence > total * MAX_SILENCE) {
    bad.push('silent for ' + (worstSilence / total * 100).toFixed(0) + '% of the build');
  }

  const missing = STAGES.filter((s) => !stages.has(s));
  if (missing.length > 0) bad.push('stages never named: ' + missing.join(', '));

  return {
    ok: bad.length === 0,
    detail: fractions.length + ' reports over ' + Math.round(total) + ' ms, worst step '
      + (worstStep * 100).toFixed(0) + '%, worst silence '
      + (worstSilence / total * 100).toFixed(0) + '%'
      + (bad.length === 0 ? '' : ' | ' + bad.join('; ')),
  };
}
