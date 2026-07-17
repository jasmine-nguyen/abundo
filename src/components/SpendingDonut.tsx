import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { G, Circle } from 'react-native-svg';
import { C, FONT } from '../theme';

// WHIT: a donut ("pie") chart of where the cycle's money went — one slice per top-level
// category, sized by its share of the total, painted in that category's own colour so the
// ring and the rows below it read as one legend. The category rows underneath double as the
// chart's legend + table view (name · amount · share), so the donut needs no separate key.

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
// for the centred leading-share stat.
const SIZE = 184;
const STROKE = 26;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
const CENTER = SIZE / 2;
// A small surface gap between adjacent wedges (dataviz: 2px surface gap between fills), in
// path-length units. Dropped when there is only one slice (a full ring has no seam).
const GAP = 2;

// A donut of category spend for the selected cycle. `slices` are the top-level categories
// (already this cycle's). The hole highlights the leading category — where most of the money
// went — complementing (not repeating) the hero total above. Renders nothing when there is no
// positive spend — the screen shows its own empty state instead.
export function SpendingDonut({ slices, testID }: { slices: DonutSlice[]; testID?: string }) {
  const painted = reduceSlices(slices);
  const sum = painted.reduce((acc, s) => acc + s.value, 0);
  if (sum <= 0) return null;

  const single = painted.length === 1;
  let offset = 0;
  const arcs = painted.map((s) => {
    const frac = s.value / sum;
    const gap = single ? 0 : GAP;
    // Clamp so a hair-thin slice never goes negative once the gap is subtracted.
    const seg = Math.max(0, frac * CIRC - gap);
    const dash = `${seg} ${CIRC - seg}`;
    const arc = (
      <Circle
        key={s.id}
        cx={CENTER}
        cy={CENTER}
        r={R}
        fill="none"
        stroke={s.color}
        strokeWidth={STROKE}
        strokeDasharray={dash}
        strokeDashoffset={-offset}
      />
    );
    offset += frac * CIRC;
    return arc;
  });

  const pct = (v: number) => (sum > 0 ? Math.round((v / sum) * 100) : 0);
  // painted[0] is the largest single category — kept slices are sorted desc and "Other" (a sum
  // of the smaller tail) is only ever appended after them, so it can never be painted[0].
  const lead = painted[0];
  const label = `Spending by category. ${painted
    .map((s) => `${s.name} ${pct(s.value)} percent`)
    .join(', ')}.`;

  return (
    <View style={styles.wrap} testID={testID} accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={SIZE} height={SIZE}>
        {/* Track behind the wedges so a partial ring still reads as a full circle. */}
        <Circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke={C.hairlineStrong} strokeWidth={STROKE} />
        {/* Start the first wedge at 12 o'clock and run clockwise. */}
        <G rotation={-90} origin={`${CENTER}, ${CENTER}`}>{arcs}</G>
      </Svg>
      {/* The hole highlights the leading share as a bare percentage (the colour ring + the
          rows below name WHICH category) — a repeated $-total or category name would just
          duplicate the hero/rows. */}
      <View style={styles.center} pointerEvents="none">
        <Text style={styles.centerPct}>{pct(lead.value)}%</Text>
        <Text style={styles.centerName}>top category</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  centerPct: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.textBright, letterSpacing: -1 },
  centerName: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.textDim, marginTop: 2, textAlign: 'center' },
});
