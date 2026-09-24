// @ts-check
/**
 * What the merge button offers right now, and why, in one place.
 *
 * The button and the action used to answer to different questions: the button
 * lit whenever a plan freed something, while `mergeColors()` also needed a
 * model and a build that was not running. A palette can hold colours before any
 * model exists (a view image interns its colours as it is decoded), so the
 * button was reachable with nothing to merge into - pressed, it returned in
 * silence. `docs/DESIGN.md` §7 calls that out by name: "Кнопка активна, по
 * нажатию — ошибка" is the wrong column.
 *
 * So the decision is one function, outside `src/main.js` because that module
 * needs a DOM and a WebGL2 context and cannot be imported in Node
 * (`docs/TESTING.md`, "Чего проверки не видят"). The page renders what this
 * returns; the click applies the plan this returned.
 */

/**
 * @typedef {object} MergeOffer
 * @property {{remap: Uint8Array, freed: number[], groups: number, worst: number}|null} plan
 *   the merge the click would apply, or null when there is nothing to apply
 * @property {boolean} enabled whether the button may be pressed
 * @property {string} noteKey i18n key for the line under the button, '' for none
 * @property {Record<string, number>|undefined} noteParams params for that key
 * @property {boolean} warn the note is the reason something is off, so it wears
 *   `.hint.warn` rather than a plain `.hint` (`docs/DESIGN.md` §8)
 */

/**
 * Decide the merge button's state from the world it acts on.
 *
 * The plan is built against the usage counts when they are complete, so the
 * colour painting more of the model is the one that keeps its index. Without
 * counts `planMerge` falls back to index order, which is still deterministic.
 *
 * @param {object} world
 * @param {import('../core/palette.js').Palette} world.palette
 * @param {{remapFaces: Function}|null} world.volume the model, or null
 * @param {boolean} world.building a build is in flight
 * @param {number} world.deltaE how close two colours have to be to merge
 * @param {Uint32Array|undefined} [world.weights] complete per-slot face counts
 * @returns {MergeOffer}
 */
export function mergeOffer(world) {
  /**
   * @param {string} noteKey
   * @param {Record<string, number>|undefined} noteParams
   * @returns {MergeOffer}
   */
  const off = (noteKey, noteParams) => ({
    plan: null, enabled: false, noteKey, noteParams, warn: true,
  });

  // The build comes first: it is the more informative reason, and it is the one
  // that goes away by itself.
  if (world.building) return off('edit.mergeBuilding', undefined);
  if (!world.volume) return off('edit.mergeNoModel', undefined);
  if (world.palette.live === 0) return off('edit.mergeNoModel', undefined);

  const plan = world.palette.planMerge(world.deltaE, world.weights);
  const n = plan.freed.length;
  if (n > 0) {
    return {
      plan, enabled: true, noteKey: 'edit.mergeReady', noteParams: { n }, warn: false,
    };
  }
  const free = world.palette.free.size;
  if (free > 0) return off('edit.mergeFree', { n: free });
  return off('edit.mergeNone', undefined);
}
