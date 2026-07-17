import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { G, Circle, Path } from 'react-native-svg';
import { C, FONT, fmt } from '../theme';

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

// Fixed geometry — a square SVG the ring is inscribed in. A ~26px band leaves a roomy hole
// for the centred stat. PAD keeps the ring clear of the canvas edge so a tapped wedge has room
// to POP outward (grow past the others) without clipping.
const SIZE = 192;
const STROKE = 26;
const PAD = 11;      // clear space around the ring
const POP = 9;       // how far the selected wedge grows outward
const CENTER = SIZE / 2;
const R = CENTER - PAD - STROKE / 2;        // resting mid-line radius of the ring
const CIRC = 2 * Math.PI * R;
// A small surface gap between adjacent wedges (dataviz: 2px surface gap between fills). As an
// angle: the whole ring is 360°, so 2px of the circumference is (2 / CIRC) × 360.
const GAP_DEG = (2 / CIRC) * 360;
// The selected wedge grows OUTWARD only — its mid-line lifts by POP/2 and it thickens by POP —
// so its inner edge stays put (never eats into the centre text) while its outer edge bulges out.
const R_SEL = R + POP / 2;
const STROKE_SEL = STROKE + POP;

// A point at `deg` on a circle of radius `r` (0° = 3 o'clock, +ve clockwise in SVG's y-down space).
function ptOnRing(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CENTER + r * Math.cos(a), CENTER + r * Math.sin(a)];
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
// to read that category's name + total instead. Renders nothing when there is no positive
// spend — the screen shows its own empty state instead.
export function SpendingDonut({ slices, testID }: { slices: DonutSlice[]; testID?: string }) {
  const painted = reduceSlices(slices);
  const sum = painted.reduce((acc, s) => acc + s.value, 0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (sum <= 0) return null;

  const pct = (v: number) => (sum > 0 ? Math.round((v / sum) * 100) : 0);
  const single = painted.length === 1;
  const selected = painted.find((s) => s.id === selectedId) ?? null;

  // Lay the wedges out by angle, starting at 12 o'clock (−90°) and running clockwise.
  let cursor = -90;
  const wedges = painted.map((s) => {
    const sweep = (s.value / sum) * 360;
    const start = cursor;
    const end = cursor + sweep;
    cursor = end;
    const isSel = s.id === selectedId;
    // The tapped wedge pops OUT (bigger radius + thicker band); the rest dim back so it stands out.
    const opacity = selected && !isSel ? 0.32 : 1;
    const r = isSel ? R_SEL : R;
    const strokeW = isSel ? STROKE_SEL : STROKE;
    const onPress = () => setSelectedId((cur) => (cur === s.id ? null : s.id));
    // react-native-svg's native types expose only accessibilityLabel (not role/state), so the
    // selected state rides in the label rather than accessibilityState.
    const a11y = `${s.name}, ${fmt(s.value)}, ${pct(s.value)} percent${isSel ? ', selected' : ''}`;

    if (single) {
      // A lone 100% slice is a full ring — an arc whose start and end coincide degenerates, so
      // draw it as a plain circle instead.
      return (
        <Circle
          key={s.id}
          testID={`donut-slice-${s.id}`}
          cx={CENTER}
          cy={CENTER}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth={strokeW}
          opacity={opacity}
          onPress={onPress}
          accessible
          accessibilityLabel={a11y}
        />
      );
    }
    // Inset each end by half the gap so neighbours don't touch; a wedge too thin to inset keeps
    // its full sweep rather than inverting.
    const inset = sweep > GAP_DEG * 1.5 ? GAP_DEG / 2 : 0;
    return (
      <Path
        key={s.id}
        testID={`donut-slice-${s.id}`}
        d={arcPath(start + inset, end - inset, r)}
        fill="none"
        stroke={s.color}
        strokeWidth={strokeW}
        strokeLinecap="butt"
        opacity={opacity}
        onPress={onPress}
        accessible
        accessibilityLabel={a11y}
      />
    );
  });
  // Draw the popped wedge last so its enlarged band sits on top of its neighbours.
  if (selectedId) {
    const i = wedges.findIndex((w) => w.key === selectedId);
    if (i >= 0) wedges.push(...wedges.splice(i, 1));
  }

  // painted[0] is the largest single category — kept slices are sorted desc and "Other" (a sum
  // of the smaller tail) is only ever appended after them, so it can never be painted[0].
  const lead = painted[0];
  const label = `Spending by category. ${painted
    .map((s) => `${s.name} ${pct(s.value)} percent`)
    .join(', ')}. Tap a slice for its total.`;

  return (
    <View style={styles.wrap} testID={testID} accessibilityLabel={label}>
      <Svg width={SIZE} height={SIZE}>
        {/* Track behind the wedges so a partial ring still reads as a full circle. */}
        <Circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke={C.hairlineStrong} strokeWidth={STROKE} />
        <G>{wedges}</G>
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
