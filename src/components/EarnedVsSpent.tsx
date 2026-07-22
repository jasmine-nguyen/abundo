import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, fmt } from '../theme';

// WHIT-312: an "earned vs spent" read for the selected pay cycle — two horizontal bars
// (earned in the app's positive teal, spent in the overspend coral) plus a plain-language
// verdict on the ACTUAL money left over (earned − spent). Both numbers are server-computed
// over the SAME window, so the bars line up. The bigger amount fills the track; the smaller
// is drawn proportionally beside it (so the comparison is read by relative length).
// Deliberately NOT the budgeted-vs-actual view (grey target tracks + "budgeted surplus") —
// that's a separate follow-up, because budgets only exist for the current cycle.

const EPS = 0.005; // sub-cent slack so float noise can't flip the "broke even" verdict

// The math behind the chart, pure + exported so a test pins every branch without rendering.
// Non-finite inputs (a hand-mocked screen can pass `undefined`) coerce to 0 rather than
// spilling NaN into a bar width. `share` is each amount over the larger of the two, so the
// bigger bar is full-width and the smaller is proportional.
export function earnedVsSpent(earned: number, spent: number): {
  leftover: number; overspent: boolean; even: boolean;
  earnedShare: number; spentShare: number; verdict: string;
} {
  const earnedAmount = Number.isFinite(earned) ? earned : 0;
  const spentAmount = Number.isFinite(spent) ? spent : 0;
  const leftover = earnedAmount - spentAmount;
  const even = Math.abs(leftover) < EPS;
  const overspent = leftover < -EPS;
  const max = Math.max(earnedAmount, spentAmount);
  const earnedShare = max > 0 ? earnedAmount / max : 0;
  const spentShare = max > 0 ? spentAmount / max : 0;

  let verdict: string;
  if (earnedAmount <= 0 && spentAmount <= 0) verdict = 'No activity yet';
  else if (earnedAmount <= 0) verdict = 'No income recorded yet';
  else if (spentAmount <= 0) verdict = 'Nothing spent yet';
  else if (even) verdict = 'You broke even';
  else if (overspent) verdict = `You overspent by ${fmt(Math.abs(leftover))}`;
  else verdict = `You have ${fmt(leftover)} left over`;

  return { leftover, overspent, even, earnedShare, spentShare, verdict };
}

// One labelled bar: its amount and a track whose fill is `share` of full width. The fill
// carries the testID so a test can read its width.
function Bar({ label, amount, share, color, testID }: {
  label: string; amount: number; share: number; color: string; testID: string;
}) {
  return (
    <View style={styles.barBlock}>
      <View style={styles.barHead}>
        <Text style={styles.barLabel}>{label}</Text>
        <Text style={[styles.barAmount, { color }]}>{fmt(amount)}</Text>
      </View>
      <View style={styles.track}>
        <View testID={testID} style={{ width: `${share * 100}%`, backgroundColor: color, height: '100%', borderRadius: 5 }} />
      </View>
    </View>
  );
}

// The earned-vs-spent card. Renders nothing when there was neither income nor spend this
// cycle — the screen shows its own empty state instead (mirrors SpendingDonut).
export function EarnedVsSpent({ earned, spent, testID }: { earned: number; spent: number; testID?: string }) {
  const { earnedShare, spentShare, verdict } = earnedVsSpent(earned, spent);
  const earnedAmount = Number.isFinite(earned) ? earned : 0;
  const spentAmount = Number.isFinite(spent) ? spent : 0;
  if (earnedAmount <= 0 && spentAmount <= 0) return null;

  const label = `Earned ${fmt(earnedAmount)}, spent ${fmt(spentAmount)}. ${verdict}.`;
  return (
    <View style={styles.card} testID={testID} accessibilityLabel={label}>
      <Bar label="Earned" amount={earnedAmount} share={earnedShare} color={C.good} testID="earned-bar" />
      <Bar label="Spent" amount={spentAmount} share={spentShare} color={C.bad} testID="spent-bar" />
      <Text testID="earned-vs-spent-verdict" style={styles.verdict}>{verdict}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 18, marginBottom: 22 },
  barBlock: { marginBottom: 14 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  barLabel: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textDim },
  barAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', letterSpacing: -0.4 },
  track: { height: 10, backgroundColor: 'rgba(255,255,255,.05)', borderRadius: 5, overflow: 'hidden' },
  verdict: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textBright, textAlign: 'center', marginTop: 4 },
});
