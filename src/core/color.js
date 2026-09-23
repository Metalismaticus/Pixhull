// @ts-check
/**
 * Perceptual colour distance.
 *
 * The palette used to compare colours with redmean, a weighted RGB distance.
 * Redmean is cheap and fine for "roughly which of these is closer", but it is
 * not a perceptual space: it puts a white body's anti-aliasing shades further
 * apart than they look, and a saturated red closer to grey than it looks. Both
 * errors push exactly the wrong way when 255 slots have to describe the art.
 *
 * So colours are converted to CIE L*a*b* (sRGB, D65) and compared with
 * CIEDE2000, which is what the CIE recommends for small differences and what
 * every quantiser worth the name uses. Rule of thumb for reading the numbers
 * below: dE 1 is the threshold of noticing, dE 2 is "the same colour" to anyone
 * not staring, dE 10 is a different colour.
 *
 * The CIEDE2000 formula is transcribed by hand from
 *   Sharma, Wu, Dalal, "The CIEDE2000 Color-Difference Formula" (2005),
 * cross-checked against the MIT-licensed `image-q` implementation of the same
 * paper. No code is imported: this project ships no dependencies
 * (`docs/DECISIONS.md`).
 */

const DEG = Math.PI / 180;
/** D65 white point, the one sRGB is defined against. */
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

/** sRGB transfer function, channel 0..255 -> linear 0..1. */
function linearize(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labf(t) {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037035 * t + 16 / 116;
}

/**
 * sRGB to CIE L*a*b*.
 * @param {number} r @param {number} g @param {number} b each 0..255
 * @returns {[number, number, number]}
 */
export function rgbToLab(r, g, b) {
  const R = linearize(r);
  const G = linearize(g);
  const B = linearize(b);
  const x = labf((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN);
  const y = labf((0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / YN);
  const z = labf((0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / ZN);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * @param {number} packed 0xRRGGBB
 * @returns {[number, number, number]}
 */
export function packedToLab(packed) {
  return rgbToLab((packed >> 16) & 255, (packed >> 8) & 255, packed & 255);
}

/**
 * CIEDE2000 difference between two L*a*b* colours.
 * @param {number} L1 @param {number} a1 @param {number} b1
 * @param {number} L2 @param {number} a2 @param {number} b2
 * @returns {number} dE00, 0 for identical colours
 */
export function ciede2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) * 0.5;
  const C7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 6103515625))); // 25^7
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);
  // Hue is undefined for a neutral colour; the standard says take it as 0 so
  // that grey against grey does not produce a hue term out of rounding noise.
  let hp1 = Cp1 === 0 ? 0 : Math.atan2(b1, ap1) / DEG;
  if (hp1 < 0) hp1 += 360;
  let hp2 = Cp2 === 0 ? 0 : Math.atan2(b2, ap2) / DEG;
  if (hp2 < 0) hp2 += 360;

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;

  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * 0.5) * DEG);

  const Lbar = (L1 + L2) * 0.5;
  const Cpbar = (Cp1 + Cp2) * 0.5;
  let hbar = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    const diff = Math.abs(hp1 - hp2);
    if (diff > 180) hbar = hp1 + hp2 < 360 ? hbar + 360 : hbar - 360;
    hbar *= 0.5;
  } else {
    hbar *= 0.5;
    // One of the two is neutral: its hue contributed nothing, so the mean is
    // the other one's hue rather than half of it.
    if (Cp1 === 0) hbar = hp2;
    else if (Cp2 === 0) hbar = hp1;
  }

  const T = 1
    - 0.17 * Math.cos((hbar - 30) * DEG)
    + 0.24 * Math.cos(2 * hbar * DEG)
    + 0.32 * Math.cos((3 * hbar + 6) * DEG)
    - 0.20 * Math.cos((4 * hbar - 63) * DEG);

  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const Cpbar7 = Math.pow(Cpbar, 7);
  const RC = 2 * Math.sqrt(Cpbar7 / (Cpbar7 + 6103515625));
  const Lm50 = (Lbar - 50) * (Lbar - 50);
  const SL = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50);
  const SC = 1 + 0.045 * Cpbar;
  const SH = 1 + 0.015 * Cpbar * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  const tL = dL / SL;
  const tC = dC / SC;
  const tH = dH / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/**
 * CIEDE2000 between two packed sRGB colours. Convenience for one-off
 * comparisons; anything in a loop should convert to Lab once and stay there.
 * @param {number} p1 @param {number} p2 both 0xRRGGBB
 * @returns {number}
 */
export function ciede2000Packed(p1, p2) {
  const [L1, a1, b1] = packedToLab(p1);
  const [L2, a2, b2] = packedToLab(p2);
  return ciede2000(L1, a1, b1, L2, a2, b2);
}
