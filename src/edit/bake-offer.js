// @ts-check
/**
 * What a bake button offers right now, and why, in one place.
 *
 * Same shape and the same reason as `merge-offer.js`: the button and the action
 * must answer one question, or the panel offers something the click refuses in
 * silence - the wrong column of `docs/DESIGN.md` §7. It lives outside
 * `src/main.js` because that module needs a DOM and a WebGL2 context and cannot
 * be imported in Node (`docs/TESTING.md`, "Чего проверки не видят").
 *
 * The one thing it does differently: the plan it carries may be *incomplete*.
 * A bake plan walks every exposed face, so on a large model it runs on a
 * deadline like the usage count does. An unfinished count is still worth
 * showing - it is a floor, not a lie - but it says so, and the button stays
 * live, because applying has no budget and always walks the whole model.
 */

import { planBake } from '../core/bake.js';

/**
 * @typedef {object} BakeOffer
 * @property {import('../core/bake.js').BakePlan|null} plan what the press would
 *   cost, or null when there is nothing to press
 * @property {boolean} enabled whether the button may be pressed
 * @property {string} noteKey i18n key for the line under the buttons, '' for none
 * @property {Record<string, number|string>|undefined} noteParams params for it
 * @property {boolean} warn the note is the reason something is off or risky, so
 *   it wears `.hint.warn` rather than a plain `.hint` (`docs/DESIGN.md` §8)
 */

/**
 * Decide a bake button's state from the world it acts on.
 *
 * @param {object} world
 * @param {import('../core/palette.js').Palette} world.palette
 * @param {import('../core/volume.js').Volume|null} world.volume the model, or null
 * @param {boolean} world.building a build is in flight
 * @param {import('../core/bake.js').BakeOptions} world.opts which bake, how thick
 * @param {number} [world.deadline] `performance.now()` value to stop counting at
 * @returns {BakeOffer}
 */
export function bakeOffer(world) {
  /**
   * @param {string} noteKey
   * @param {Record<string, number|string>|undefined} [noteParams]
   * @returns {BakeOffer}
   */
  const off = (noteKey, noteParams) => ({
    plan: null, enabled: false, noteKey, noteParams, warn: true,
  });

  // The build comes first: it is the more informative reason, and it is the one
  // that goes away by itself.
  if (world.building) return off('edit.bakeBuilding');
  if (!world.volume) return off('edit.bakeNoModel');
  if (world.palette.live === 0) return off('edit.bakeNoModel');

  const plan = planBake(world.volume, world.palette, world.opts, world.deadline);
  if (plan.faces === 0 && plan.complete) return off('edit.bakeNothing');

  // A palette that cannot hold the colours the bake wants does not refuse: the
  // extra faces land on the nearest colour it already has. That is a result
  // worth warning about before the press, not a reason to dim the button.
  if (plan.overflow) {
    // An unfinished count cannot take the warning back: the palette is already
    // short of the colours counted so far, and finishing would only widen the
    // gap. It says the numbers are a floor rather than quietly passing them off
    // as totals.
    return {
      plan,
      enabled: true,
      noteKey: plan.complete ? 'edit.bakeOverflow' : 'edit.bakeOverflowPartial',
      noteParams: { n: plan.newColours, free: plan.spare, faces: plan.faces },
      warn: true,
    };
  }

  return {
    plan,
    enabled: true,
    noteKey: plan.complete ? 'edit.bakeReady' : 'edit.bakePartial',
    noteParams: { n: plan.newColours, free: plan.spare, faces: plan.faces },
    warn: !plan.complete,
  };
}
