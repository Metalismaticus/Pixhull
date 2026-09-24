// @ts-check
/**
 * The build, running somewhere that is not the tab's main thread.
 *
 * All this file does is wire one message to one result; the work itself is
 * `src/core/carve-job.js`, which knows nothing about workers and is checked in
 * Node. Nothing here may touch the DOM - a worker has none - and nothing here
 * may hold state between messages, because the page throws the worker away
 * after every build.
 *
 * The wiring is guarded by a `typeof` test rather than assumed, so that
 * `tools/check.mjs` can import this file in Node like every other module and
 * still see a syntax error if there is one.
 */

import { runCarveJob } from '../core/carve-job.js';

/** No point posting a number the bar cannot show: a pixel is about 1%. */
const STEP = 0.01;
const MIN_GAP_MS = 60;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const job = e.data;
    let sent = -1;
    let sentAt = -Infinity;
    try {
      const result = runCarveJob(job, (fraction, stage) => {
        const now = performance.now();
        if (fraction < 1 && fraction - sent < STEP && now - sentAt < MIN_GAP_MS) return;
        sent = fraction;
        sentAt = now;
        self.postMessage({ type: 'progress', id: job.id, fraction, stage });
      });
      self.postMessage({
        type: 'done',
        id: job.id,
        volume: result.volume,
        faces: result.faces,
        palette: result.palette,
        stats: result.stats,
        box: result.box,
      }, result.transfer);
    } catch (err) {
      // A build that throws has to say so: the page is showing a progress bar
      // that would otherwise sit there for ever.
      self.postMessage({
        type: 'error',
        id: job.id,
        message: String(err instanceof Error ? err.message : err),
      });
    }
  };
}
