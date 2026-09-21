// Hand-written WCAG 2.x contrast maths, shared by the colour-contrast suites (WHIT-430 / WHIT-431).
//
// LOUD WARNING — this file must NEVER import from src/contrast.ts, and must stay hand-written.
// These helpers exist to measure the shipped colours (and src/contrast.ts itself) INDEPENDENTLY;
// importing the code under test would only prove it agrees with itself, turning the guards into
// tautologies. That independence is the whole point of this file.
//
// Two suites (otherColorToken.logic, contrastEdges.logic) each carried their own copy of this maths
// and had already drifted — one rounded the blend to whole channels, one did not. This is the one
// merged copy. The blend (compositeOver) is DELIBERATELY UNROUNDED: it matches what CoreGraphics /
// Skia actually do, and what src/contrast.ts's own compositeOver documents. The old rounding lived
// only in the copy that produced a hex STRING; working in rgb arrays here removes any need to round,
// so the drift is settled on the renderer-faithful (unrounded) maths.

// A 3-tuple, matching src/contrast.ts's Rgb, so these helpers can also feed that module's
// primitives in the edge suites (e.g. minOpacityForContrast) without a cast.
export type Rgb = readonly [number, number, number];

// #rrggbb → [r, g, b]. The suites only ever hand this 6-digit shipped colours.
export const hexToRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const linearize = (channel: number): number => {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
};

export const relativeLuminance = (rgb: Rgb): number =>
  0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);

export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// Unrounded gamma-space blend of `fg` over `bg` at `alpha` — see the header note on rounding.
export const compositeOver = (fg: Rgb, bg: Rgb, alpha: number): Rgb => {
  const mix = (i: number) => alpha * fg[i] + (1 - alpha) * bg[i];
  return [mix(0), mix(1), mix(2)];
};

// Hex convenience for the suites that hold colours as strings.
export const contrastHex = (aHex: string, bHex: string): number =>
  contrastRatio(hexToRgb(aHex), hexToRgb(bHex));

// A faded wedge as it reaches the eye: `hex` blended over the opaque track `bgHex` at `alpha`,
// returned as rgb (unrounded). Then measure with contrastRatio against the same track.
export const fadedOver = (hex: string, alpha: number, bgHex: string): Rgb =>
  compositeOver(hexToRgb(hex), hexToRgb(bgHex), alpha);
