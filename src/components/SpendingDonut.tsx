import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import Svg, { G, Circle, Path } from 'react-native-svg';
import { C, FONT, fmt } from '../theme';
import { useReduceMotion } from '../motion/useReduceMotion';

// WHIT: a donut ("pie") chart of where the cycle's money went — one slice per top-level
// category, sized by its share of the total, painted in that category's own colour so the
// ring and the rows below it read as one legend. The category rows underneath double as the
// chart's legend + table view (name · amount · share), so the donut needs no separate key.
// Tap a wedge to read that category's name + total in the hole; tap it again to clear.

// Neutral grey for the grouped "Other" slice — distinct from any category hue, and reads as
// "not one thing" rather than competing for identity with the real categories.
const OTHER_COLOR = C.textFaint;

export interface DonutSlice { id: string; name: string; color: string; value: number }

// Reduce the full top-level list to at most `max` painted slices: keep the largest `max-1`,
// fold everything smaller into a single neutral "Other" slice. A pie with too many thin
// wedges is unreadable (dataviz: a 9th series folds into "Other"), and the rows below still
// show every category in full. Pure + exported so a unit test can pin the grouping.
export function reduceSlices(slices: DonutSlice[], max = 6): DonutSlice[] {
  const positive = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (positive.length <= max) return positive;
  const kept = positive.slice(0, max - 1);
  const rest = positive.slice(max - 1);
  const otherValue = rest.reduce((sum, s) => sum + s.value, 0);
  if (otherValue > 0) kept.push({ id: '__other__', name: 'Other', color: OTHER_COLOR, value: otherValue });
  return kept;
}

// Where a wedge sits on the emphasis axis, given the current selection: +1 popped (this is the
// tapped one), −1 dimmed (something else is tapped), 0 at rest (nothing tapped). Pure so a test
// can pin it without reaching into the animation. The scale/opacity below are just this mapped.
export function sliceEmphasis(isSelected: boolean, anySelected: boolean): -1 | 0 | 1 {
  if (isSelected) return 1;
  return anySelected ? -1 : 0;
}

// Fixed geometry — a ~26px band leaves a roomy hole for the centred stat. The ring is DRAWN
// centred on the coordinate origin (0,0); a single static parent <G> then shifts it to the box
// centre (see the render). CENTER is half the nominal ring box, used only to derive the radius.
const SIZE = 192;
const STROKE = 26;
const PAD = 11;
const CENTER = SIZE / 2;
const R = CENTER - PAD - STROKE / 2;        // mid-line radius of the ring
const CIRC = 2 * Math.PI * R;
// A small surface gap between adjacent wedges (dataviz: 2px surface gap between fills). As an
// angle: the whole ring is 360°, so 2px of the circumference is (2 / CIRC) × 360.
const GAP_DEG = (2 / CIRC) * 360;
// The popped wedge grows a touch (1.1×) to lift it off its neighbours, and must grow ABOUT THE
// CENTRE so it stays in place. react-native-svg's native group takes a single pre-composed
// `matrix`, and on an *animated* G only the scale component of that matrix reliably lands each
// frame — any translate/origin is dropped (so scaling an animated G alone happens about the
// origin (0,0), sliding the wedge toward a corner). The centring therefore lives on the STATIC
// parent group (baked in once at render, never dropped); each wedge's animation carries ONLY a
// scale about its own origin, which the parent's shift turns into a scale about the centre.
const SEL_SCALE = 1.1;
// How far the un-focused wedges fade back when one is picked. Low enough to clearly recede,
// high enough to stay legible (they're not gone, just quiet).
const DIM = 0.22;
// Size the (transparent) canvas from the pop so a popped wedge never reaches the edge and clips.
// POP_OUTER is the farthest a popped wedge reaches from the centre; pad past it by MARGIN, and
// centre the ring in the box so the headroom is symmetric on every side. Derived from SEL_SCALE
// (not a hardcoded budget) so the margin can't silently go negative if the pop is retuned.
const POP_OUTER = (R + STROKE / 2) * SEL_SCALE;   // 93.5 with defaults — farthest reach when popped
const MARGIN = 10;                                // breathing room around the popped ring
const VIEW = 2 * Math.ceil(POP_OUTER + MARGIN);   // 208 with defaults — box grows, ring stays same size

const AnimatedG = Animated.createAnimatedComponent(G);

// A point at `deg` on a circle of radius `r` centred on the origin (0° = 3 o'clock, +ve clockwise
// in SVG's y-down space). Origin-centred so a wedge's scale (about its own origin) grows it in
// place; the static parent <G> shifts the whole ring to the box centre.
function ptOnRing(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}

// A stroked arc path following radius `r` from `startDeg` to `endDeg` (clockwise). The stroke
// band IS the visible wedge, and — unlike a full-circle dashed stroke — its hit area is only
// this segment, so each wedge can own a tap.
function arcPath(startDeg: number, endDeg: number, r: number): string {
  const [x1, y1] = ptOnRing(startDeg, r);
  const [x2, y2] = ptOnRing(endDeg, r);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// A donut of category spend for the selected cycle. `slices` are the top-level categories
// (already this cycle's). The hole shows the leading category's share by default; tap any wedge
// to pop it out and read that category's name + total instead. Renders nothing when there is no
// positive spend — the screen shows its own empty state instead.
export function SpendingDonut({ slices, testID }: { slices: DonutSlice[]; testID?: string }) {
  const painted = reduceSlices(slices);
  const sum = painted.reduce((acc, s) => acc + s.value, 0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reduceMotion = useReduceMotion();
  // One Animated.Value per wedge on the [−1, +1] emphasis axis (see sliceEmphasis). Kept in a
  // ref so it survives redraws; new ids default to 0 (at rest), which is the correct start.
  const anims = useRef<Map<string, Animated.Value>>(new Map()).current;
  const emphasisOf = (id: string): Animated.Value => {
    let v = anims.get(id);
    if (!v) { v = new Animated.Value(0); anims.set(id, v); }
    return v;
  };

  // Spring each wedge toward its target when the selection changes (instant under reduce-motion).
  useEffect(() => {
    const springs = painted.map((s) => {
      const target = sliceEmphasis(s.id === selectedId, selectedId !== null);
      const v = emphasisOf(s.id);
      if (reduceMotion) { v.setValue(target); return null; }
      return Animated.spring(v, { toValue: target, useNativeDriver: false, friction: 7, tension: 120 });
    });
    if (!reduceMotion) Animated.parallel(springs.filter(Boolean) as Animated.CompositeAnimation[]).start();
    // painted is derived from slices each render; the selection + reduce-motion flag are what
    // actually re-target the springs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, reduceMotion]);

  if (sum <= 0) return null;

  const pct = (v: number) => (sum > 0 ? Math.round((v / sum) * 100) : 0);
  const single = painted.length === 1;
  const selected = painted.find((s) => s.id === selectedId) ?? null;

  // Lay the wedges out by angle, starting at 12 o'clock (−90°) and running clockwise. Compute
  // each wedge's arc geometry once so the on-top overlay can reuse it without recomputing.
  let cursor = -90;
  const layout = painted.map((s) => {
    const sweep = (s.value / sum) * 360;
    const start = cursor;
    const end = cursor + sweep;
    cursor = end;
    // Inset each end by half the gap so neighbours don't touch; a wedge too thin to inset keeps
    // its full sweep rather than inverting.
    const inset = sweep > GAP_DEG * 1.5 ? GAP_DEG / 2 : 0;
    return { s, start, end, inset };
  });

  // Render one wedge's animated group. Interactive wedges own the tap + accessibility label; the
  // single on-top overlay copy is inert — no tap target, not focusable — so it neither duplicates
  // the hit area / a11y label nor collides with the base wedge's testID.
  const renderWedge = ({ s, start, end, inset }: (typeof layout)[number], interactive: boolean) => {
    // The wedge's animated group: scale up (pop) on the +1 side, fade (dim) on the −1 side. Scale
    // ONLY — no translate/origin (those get dropped on an animated G). The wedge is drawn about the
    // origin, so this scales it in place; the static parent <G> shifts it to the box centre.
    const v = emphasisOf(s.id);
    const scale = v.interpolate({ inputRange: [-1, 0, 1], outputRange: [1, 1, SEL_SCALE], extrapolate: 'clamp' });
    const opacity = v.interpolate({ inputRange: [-1, 0, 1], outputRange: [DIM, 1, 1], extrapolate: 'clamp' });

    const isSel = s.id === selectedId;
    const shapeProps = interactive
      ? {
          testID: `donut-slice-${s.id}`,
          onPress: () => setSelectedId((cur) => (cur === s.id ? null : s.id)),
          accessible: true,
          // react-native-svg's native types expose only accessibilityLabel (not role/state), so
          // the selected state rides in the label rather than accessibilityState.
          accessibilityLabel: `${s.name}, ${fmt(s.value)}, ${pct(s.value)} percent${isSel ? ', selected' : ''}`,
        }
      : { testID: 'donut-top', accessible: false };

    const shape = single ? (
      // A lone 100% slice is a full ring — an arc whose start and end coincide degenerates, so
      // draw it as a plain circle instead.
      <Circle cx={0} cy={0} r={R} fill="none" stroke={s.color} strokeWidth={STROKE} {...shapeProps} />
    ) : (
      <Path d={arcPath(start + inset, end - inset, R)} fill="none" stroke={s.color} strokeWidth={STROKE} strokeLinecap="butt" {...shapeProps} />
    );

    return (
      <AnimatedG key={interactive ? s.id : '__top__'} scale={scale} opacity={opacity}>
        {shape}
      </AnimatedG>
    );
  };

  // Base wedges in stable paint order — never reordered. Reordering keyed children mid-animation
  // detaches the animating node and hitches; instead the selected wedge is redrawn once by an
  // appended, inert overlay, so it sits on top of its neighbours without any reorder.
  const wedges = layout.map((d) => renderWedge(d, true));
  const selectedLayout = selectedId ? layout.find((d) => d.s.id === selectedId) : null;
  const topWedge = selectedLayout ? renderWedge(selectedLayout, false) : null;

  // painted[0] is the largest single category — kept slices are sorted desc and "Other" (a sum
  // of the smaller tail) is only ever appended after them, so it can never be painted[0].
  const lead = painted[0];
  const label = `Spending by category. ${painted
    .map((s) => `${s.name} ${pct(s.value)} percent`)
    .join(', ')}. Tap a slice for its total.`;

  return (
    <View style={styles.wrap} testID={testID} accessibilityLabel={label}>
      {/* The box is VIEW×VIEW with 1:1 pixels. Everything is drawn about the origin and shifted to
          the box centre by ONE static parent <G> (its translate is baked into the group's matrix
          at render, so — unlike an animated translate — it's never dropped). A popped wedge then
          scales about that centre and grows in place with symmetric headroom, never clipping. */}
      <Svg width={VIEW} height={VIEW} viewBox={`0 0 ${VIEW} ${VIEW}`}>
        <G x={VIEW / 2} y={VIEW / 2}>
          {/* Track behind the wedges so a partial ring still reads as a full circle. */}
          <Circle cx={0} cy={0} r={R} fill="none" stroke={C.hairlineStrong} strokeWidth={STROKE} />
          {wedges}
          {topWedge}
        </G>
      </Svg>
      {/* Centre readout. Default: the leading category's share. Tapped: that category's name +
          total — which is what "tap a slice to see the amount" asks for. pointerEvents=none so
          taps fall through to the wedges beneath. */}
      <View style={styles.center} pointerEvents="none">
        {selected ? (
          <>
            <Text testID="donut-center-amount" style={styles.centerAmount}>{fmt(selected.value)}</Text>
            <Text style={styles.centerName} numberOfLines={2}>{selected.name}</Text>
          </>
        ) : (
          <>
            <Text style={styles.centerPct}>{pct(lead.value)}%</Text>
            <Text style={styles.centerName}>top category</Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34 },
  centerPct: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.textBright, letterSpacing: -1 },
  centerAmount: { fontFamily: FONT.display, fontSize: 28, fontWeight: '800', color: C.textBright, letterSpacing: -1 },
  centerName: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.textDim, marginTop: 2, textAlign: 'center' },
});
