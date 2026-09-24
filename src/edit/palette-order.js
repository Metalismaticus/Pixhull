// @ts-check
/**
 * The order swatches are shown in - and only that.
 *
 * The palette arrives in the order the quantiser found the colours, which is
 * by coverage: the body's own shadow lands on slot 80 between two highlights
 * it has nothing to do with, and picking "the next darker green" means hunting
 * the whole strip. Laying the swatches out by hue and then by lightness puts
 * every shade of one material together, which is how a painter reaches for
 * them.
 *
 * **This is presentation, never identity.** The slot index a swatch carries is
 * the byte written on every face wearing that colour; renumbering it would
 * void the meaning of every byte in the volume and in the undo history
 * (`CLAUDE.md`, "Правила проекта"). So this module returns indices in a new
 * order and never touches the palette.
 */

/** Hue bands, 30 degrees each, the first one centred on red. */
export const HUE_BANDS = 12;

/**
 * Saturation below which a colour is grouped with the neutrals rather than
 * with a hue.
 *
 * Chosen here rather than measured: at 0.12 the greys, whites and blacks of
 * the test truck's palette land in the neutral band while its dullest painted
 * metal still keeps its hue. Raising it swallows muted colours, lowering it
 * scatters near-greys across every band.
 */
export const NEUTRAL_SATURATION = 0.12;

/**
 * HSL of a packed 0xRRGGBB colour.
 * @param {number} packed
 * @returns {{h: number, s: number, l: number}} h in degrees, s and l in 0..1
 */
export function hsl(packed) {
  const r = ((packed >> 16) & 255) / 255;
  const g = ((packed >> 8) & 255) / 255;
  const b = (packed & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/**
 * Which band a colour belongs to: 0 for the neutrals, 1..HUE_BANDS for the
 * hues, running round the circle from red.
 * @param {number} packed
 * @returns {number}
 */
export function bandOf(packed) {
  const { h, s } = hsl(packed);
  if (s < NEUTRAL_SATURATION) return 0;
  // Shifting by half a band puts red at the centre of band 1 instead of on its
  // edge, so 358 degrees and 2 degrees are neighbours rather than strangers.
  const step = 360 / HUE_BANDS;
  return 1 + (Math.floor(((h + step / 2) % 360) / step) % HUE_BANDS);
}

/**
 * Slot indices grouped into bands, dark to light inside each band.
 *
 * Slot 0 is the reserved empty entry and is left out, and so is every slot a
 * merge freed: it holds no colour, and a swatch for it would be a black square
 * standing for nothing. Empty bands are dropped, so the caller can draw one gap
 * between every pair of returned bands.
 *
 * @param {{colors: number[], free?: Set<number>}} palette
 * @returns {number[][]}
 */
export function paletteBands(palette) {
  /** @type {number[][]} */
  const bands = [];
  for (let b = 0; b <= HUE_BANDS; b++) bands.push([]);

  for (let i = 1; i < palette.colors.length; i++) {
    if (palette.free && palette.free.has(i)) continue;
    bands[bandOf(palette.colors[i] | 0)].push(i);
  }

  for (const band of bands) {
    band.sort((a, b) => {
      const la = hsl(palette.colors[a] | 0).l;
      const lb = hsl(palette.colors[b] | 0).l;
      // Ties break on the slot index, so the order is the same every time the
      // panel is redrawn and a swatch never jumps under the cursor.
      return la === lb ? a - b : la - lb;
    });
  }

  return bands.filter((band) => band.length > 0);
}

/**
 * The shown order as one flat list - what the arrow keys walk.
 * @param {{colors: number[], free?: Set<number>}} palette
 * @returns {number[]}
 */
export function paletteOrder(palette) {
  return paletteBands(palette).flat();
}
