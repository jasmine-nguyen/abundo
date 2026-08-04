// WHIT-425: how far a donut wedge may fade and still be seen.
//
// WCAG 1.4.11 asks a graphic you need to make out to clear 3:1 against its backdrop. A faded
// wedge's backdrop is known exactly — the opaque CHART_BG track drawn under the ring — so the
// fade is COMPUTED per colour rather than picked: fade each wedge only as far as it can go while
// still clearing the bar. A dark wedge therefore fades less than a bright one, by design.
//
// Pure maths, no React Native, so the logic suite can measure it directly. Holds no colour
// literals of its own (it imports the one backdrop it needs), so it adds nothing to the WHIT-398
// raw-colour baseline.
import { CHART_BG } from './chartColors';

export type Rgb = readonly [number, number, number];
export interface ParsedColor { rgb: Rgb; alpha: number }

// The bar is 3:1; we aim a shade above it. The guard tests measure with their own independently
// written helper, so targeting an exact 3.0 could land at 2.9999 and redden a correct
// implementation. The headroom costs about 0.02 of opacity.
export const WEDGE_DIM_TARGET = 3.1;

// Fallback for a colour we cannot measure, or one that cannot clear the bar at any opacity. NOT
// 1: a wedge that does not fade at all reads as the picked one. This still steps visibly back.
// Deliberately high — if we cannot measure a colour we cannot promise it is visible, so err toward
// more opaque. Note it is NOT far above the real floors any more: the grey "Other" legitimately
// measures 0.825. So "at the fallback" and "measured 0.85" are only 0.025 apart and cannot be told
// apart by the value alone — see the WHIT-425 tech-debt card. [Q29] in otherColorToken.logic.test.ts
// is what reddens if a palette change pushes a measured floor into that gap.
export const WEDGE_DIM_MAX = 0.85;

// #rgb, #rgba, #rrggbb, #rrggbbaa — every shape this codebase writes, in either case.
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseHexColor(color: string): ParsedColor | null {
  // Not merely defensive: chartColors.ts documents `undefined` reaching a wedge's stroke when a
  // corrupt colorSlot comes off the wire, and calls it "an INVISIBLE slice — no crash". This runs
  // at render time, so without the guard that same row takes the whole Insights tab down instead.
  if (typeof color !== 'string') return null;
  const match = HEX.exec(color.trim());
  if (!match) return null;
  const digits = match[1];
  // #rgb / #rgba are shorthand: each digit doubles into a full channel.
  const full = digits.length <= 4 ? digits.replace(/./g, (d) => d + d) : digits;
  const channel = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16);
  const alpha = full.length === 8 ? channel(3) / 255 : 1;
  return { rgb: [channel(0), channel(1), channel(2)], alpha };
}

// WCAG 2.x relative luminance. The 0.04045 threshold matches the independent helper in
// otherColorToken.logic.test.ts; the alternative 0.03928 agrees to four decimal places on every
// colour we ship, so the choice is immaterial here.
function linearize(value: number): number {
  const scaled = value / 255;
  if (scaled <= 0.04045) return scaled / 12.92;
  return Math.pow((scaled + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Gamma-space blend — what CoreGraphics and Skia do. Deliberately unrounded: the renderer does
// not quantise to integers either.
export function compositeOver(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const mix = (f: number, b: number) => alpha * f + (1 - alpha) * b;
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

// The smallest opacity at which `fg` over `bg` clears `target`, or null if it never does.
//
// The RESULT ALWAYS CLEARS the target, for any pair of colours: `high` starts at 1, which the early
// return has already shown clears it, and the loop only ever moves `high` to a value that still
// does. Minimality is the weaker claim — it needs the ratio to rise with opacity, which holds when
// the channels all move the same way (true for every wedge colour over this dark track) but NOT in
// general: composite luminance is convex in alpha, so with channels moving in opposite directions
// the ratio can dip and recover, and the bisection would then settle above the true minimum. Every
// shipped colour is in the well-behaved case, and a too-high answer is safe anyway — it errs toward
// more visible, never less.
export function minOpacityForContrast(fg: Rgb, bg: Rgb, target: number): number | null {
  if (contrastRatio(fg, bg) < target) return null;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (contrastRatio(compositeOver(fg, bg, mid), bg) >= target) high = mid;
    else low = mid;
  }
  return high;
}

// How far one wedge fades when another is picked. Rounds UP to three decimals, so the shipped
// value always clears the target and the screen tests can pin exact numbers.
export function wedgeDimOpacity(color: string, background: string = CHART_BG): number {
  const wedge = parseHexColor(color);
  const backdrop = parseHexColor(background);
  if (!wedge || !backdrop) return WEDGE_DIM_MAX;
  // A see-through track would leave us guessing at what sits behind it. Refuse rather than guess.
  if (backdrop.alpha !== 1) return WEDGE_DIM_MAX;
  if (wedge.alpha === 0) return WEDGE_DIM_MAX;

  const floor = minOpacityForContrast(wedge.rgb, backdrop.rgb, WEDGE_DIM_TARGET);
  if (floor === null) return WEDGE_DIM_MAX;

  // SVG multiplies a stroke's own alpha by its group opacity, so a colour carrying alpha needs a
  // higher group value to reach the same composite. A measured floor is never trimmed to fit:
  // handing back less opacity than a colour needs returns a value that fails the target, the one
  // thing this function must not do. If even full opacity is not enough, the colour is unusable at
  // any fade and takes the same fallback as one we cannot read at all.
  const groupOpacity = Math.ceil((floor / wedge.alpha) * 1000) / 1000;
  if (groupOpacity > 1) return WEDGE_DIM_MAX;
  return groupOpacity;
}
