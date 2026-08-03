// Shared helpers for the donut screen tests — extracted so a change to the rendered node shape or
// the react-native-svg jest stub is a one-file edit, not four.
import { screen } from '@testing-library/react-native';
import type { DonutSlice } from '../../components/SpendingDonut';

// The emphasis animation lives on the AnimatedG wrapping each testID'd shape, resolved to a plain
// number under the jest SVG stub (which renders svg elements as Views). Walk up from the shape to
// the first ancestor carrying `prop`, or undefined when no ancestor has it — which is itself
// assertable: the ring track deliberately has no animated ancestor at all.
export const ancestorProp = (testID: string, prop: 'opacity' | 'scale'): number | undefined => {
  let node: any = screen.getByTestId(testID);
  while (node && node.props?.[prop] === undefined) node = node.parent;
  return node?.props?.[prop];
};

// The emphasis opacity of a wedge, by slice id.
export const opacityOf = (id: string): number | undefined => ancestorProp(`donut-slice-${id}`, 'opacity');

// Minimal slice factory — the id doubles as the display name.
export const sl = (id: string, value: number): DonutSlice => ({ id, name: id, color: '#7aa2f7', value });

// What a dimmed wedge fades to, per colour (WHIT-425 — the fade is derived from the wedge's own
// colour, so there is no single value any more). Written as LITERALS on purpose: deriving them by
// calling wedgeDimOpacity would make every assertion below a tautology against the code it pins.
export const DIM_BLUE = 0.561;   // sl()'s #7aa2f7
export const DIM_GREEN = 0.462;  // #7FD49B, used by the Fold + Selection fixtures

// The painted wedge order as it renders. `donut-slice-<id>` sits on the TAP band, one per painted
// wedge in painted order; the selection overlay is `donut-top` (not matched by this regex).
export const paintedOrder = (): string[] =>
  screen.getAllByTestId(/^donut-slice-/).map((n: any) => String(n.props.testID).replace('donut-slice-', ''));

// The PAINTED band of each wedge — the coloured arc, STROKE wide, inset at both ends by half the
// divider. DISTINCT from `donut-slice-<id>`, which is the wider TRANSPARENT tap band laid over it at
// its FULL sweep with NO inset: measure a divider on the tap band and you always read zero. Only the
// base wedges carry a band id, so a selected wedge still has exactly one painted band.
export const paintedBands = (): any[] => screen.getAllByTestId(/^donut-band-/);
export const bandPath = (id: string): string => String(screen.getByTestId(`donut-band-${id}`).props.d);

// arcPath emits exactly 11 whitespace-separated tokens: `M x1 y1 A r r 0 <largeArc> 1 x2 y2`.
// Parsed POSITIONALLY, not by regex: a zero-inset arc starting at 12 o'clock emits its x in exponent
// form ("M 5.755839955992561e-15 -94 A ..."), which a [0-9.-] character class silently fails to match.
export const arcPoints = (d: string) => {
  const t = String(d).trim().split(/\s+/);
  if (t.length !== 11 || t[0] !== 'M' || t[3] !== 'A') throw new Error(`not an arcPath: ${d}`);
  return { x1: +t[1], y1: +t[2], r: +t[4], x2: +t[9], y2: +t[10] };
};

const degOf = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;

// How far an arc travels, in degrees. atan2 returns (-180, 180] while the donut's angles run
// -90 → +270, so a raw subtraction can come out negative; arcs are always drawn clockwise, so the
// positive modulo recovers the true extent. An INVERTED arc (end before start — what an over-large
// inset would produce) surfaces here as an extent near 360, not as a negative number, so callers
// assert an UPPER bound against the wedge's own sweep rather than merely `> 0`.
export const arcExtentDeg = (d: string): number => {
  const { x1, y1, x2, y2 } = arcPoints(d);
  return ((degOf(x2, y2) - degOf(x1, y1)) % 360 + 360) % 360;
};

// The visible divider width in pixels at the ring's mid-line: straight-line distance from where one
// painted arc ends to where the next begins. Under a degree of gap the chord and the arc agree to
// ~1e-5 px, so this is the drawn width.
export const dividerGapPx = (dPrev: string, dNext: string): number => {
  const prev = arcPoints(dPrev);
  const next = arcPoints(dNext);
  return Math.hypot(next.x1 - prev.x2, next.y1 - prev.y2);
};

// The same divider measured as an ANGLE rather than in pixels. Positive-modulo for the same reason
// as arcExtentDeg: the ring's angles run -90 → +270 while atan2 returns (-180, 180].
export const dividerGapDeg = (dPrev: string, dNext: string): number => {
  const prev = arcPoints(dPrev);
  const next = arcPoints(dNext);
  return ((degOf(next.x1, next.y1) - degOf(prev.x2, prev.y2)) % 360 + 360) % 360;
};
