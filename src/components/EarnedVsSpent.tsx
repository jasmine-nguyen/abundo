import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, fmt, tint } from '../theme';

// WHIT-312/314: an "earned vs spent" read for the selected pay cycle — two horizontal bars
// (earned in the app's positive teal, spent in the overspend coral). WHIT-312 shipped the
// ACTUAL-only view (bars + a leftover verdict). WHIT-314 adds the optional budgeted overlay:
// behind each bar a faded-hue TARGET track (faded teal behind earned, faded coral behind spent)
// with the solid actual on top, plus a "budgeted surplus" line. The overlay shows only on the
// current cycle with budgets set; otherwise the component renders the actuals-only view.

const EPS = 0.005; // sub-cent slack so float noise can't flip a break-even verdict/surplus

// Coerce a non-finite input (a hand-mocked screen can pass `undefined`) to 0 rather than
// spilling NaN into a bar width.
const num = (v: number): number => (Number.isFinite(v) ? v : 0);

// The actuals-only math, pure + exported so a test pins every branch without rendering. `share`
// is each amount over the larger of the two, so the bigger bar is full-width and the smaller is
// proportional.
export function earnedVsSpent(earned: number, spent: number): {
  leftover: number; overspent: boolean; even: boolean;
  earnedShare: number; spentShare: number; verdict: string;
} {
  const earnedAmount = num(earned);
  const spentAmount = num(spent);
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

// The budgeted-overlay math, pure + exported. ONE shared max across all four values (both
// actuals AND both targets) so every bar and track is measured on the same scale: "actual of
// budgeted" reads by relative length, and an actual OVER its budget draws past its target track
// (the over-budget signal). Non-finite inputs coerce to 0.
export function earnedVsSpentBudgeted(
  earned: number, spent: number, budgetedEarned: number, budgetedSpent: number,
): {
  earnedShare: number; spentShare: number;
  budgetedEarnedShare: number; budgetedSpentShare: number;
  budgetedSurplus: number; surplusLabel: string;
} {
  const earnedAmount = num(earned);
  const spentAmount = num(spent);
  const budgetedEarnedAmount = num(budgetedEarned);
  const budgetedSpentAmount = num(budgetedSpent);
  const max = Math.max(earnedAmount, spentAmount, budgetedEarnedAmount, budgetedSpentAmount);
  const share = (v: number): number => (max > 0 ? v / max : 0);

  const budgetedSurplus = budgetedEarnedAmount - budgetedSpentAmount;
  let surplusLabel: string;
  if (budgetedSurplus > EPS) surplusLabel = `${fmt(budgetedSurplus)} budgeted surplus`;
  else if (budgetedSurplus < -EPS) surplusLabel = `${fmt(-budgetedSurplus)} budgeted shortfall`;
  else surplusLabel = 'Budgeted to break even';

  return {
    earnedShare: share(earnedAmount), spentShare: share(spentAmount),
    budgetedEarnedShare: share(budgetedEarnedAmount), budgetedSpentShare: share(budgetedSpentAmount),
    budgetedSurplus, surplusLabel,
  };
}

// One labelled bar: the amount, then a track carrying (optionally) a faded-hue TARGET fill and
// the solid ACTUAL fill on top — both left-anchored so they overlay. The solid fill keeps the
// testID (a test reads its width); the target gets `${testID}-target`. `targetShare`/
// `budgetedAmount` absent → the plain WHIT-312 bar (single fill, no caption).
function Bar({ label, amount, share, color, testID, targetShare, budgetedAmount }: {
  label: string; amount: number; share: number; color: string; testID: string;
  targetShare?: number; budgetedAmount?: number;
}) {
  return (
    <View style={styles.barBlock}>
      <View style={styles.barHead}>
        <Text style={styles.barLabel}>{label}</Text>
        <Text style={[styles.barAmount, { color }]}>{fmt(amount)}</Text>
      </View>
      <View style={styles.track}>
        {targetShare !== undefined && (
          <View testID={`${testID}-target`} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${targetShare * 100}%`, backgroundColor: tint(color, 0.22), borderRadius: 5 }} />
        )}
        <View testID={testID} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${share * 100}%`, backgroundColor: color, borderRadius: 5 }} />
      </View>
      {budgetedAmount !== undefined && (
        <Text style={styles.barSub}>of {fmt(budgetedAmount)} budgeted</Text>
      )}
    </View>
  );
}

// The earned-vs-spent card. With `budgeted`, draws the target overlay + a budgeted-surplus line;
// without it, the actuals-only view + a leftover verdict. Renders nothing only when there was
// neither income, spend, NOR a budget to show — the screen shows its own empty state instead.
export function EarnedVsSpent({ earned, spent, budgeted, testID }: {
  earned: number; spent: number;
  budgeted?: { budgetedEarned: number; budgetedSpent: number };
  testID?: string;
}) {
  const earnedAmount = num(earned);
  const spentAmount = num(spent);
  if (earnedAmount <= 0 && spentAmount <= 0 && !budgeted) return null;

  if (budgeted) {
    const budgetedEarned = num(budgeted.budgetedEarned);
    const budgetedSpent = num(budgeted.budgetedSpent);
    // A target only reads truthfully for a side that HAS a budget. With only one side budgeted
    // (e.g. spend budgets but no income target), show that side's target but NOT a "$0 budgeted"
    // caption on the other side and NOT a budgeted-surplus line (surplus needs both) — that would
    // claim a shortfall for someone who simply didn't budget income. Fall back to the leftover
    // verdict there.
    const hasEarnedBudget = budgetedEarned > 0;
    const hasSpentBudget = budgetedSpent > 0;
    const bothBudgeted = hasEarnedBudget && hasSpentBudget;
    const m = earnedVsSpentBudgeted(earnedAmount, spentAmount, budgetedEarned, budgetedSpent);

    const earnedPart = hasEarnedBudget ? `Earned ${fmt(earnedAmount)} of ${fmt(budgetedEarned)} budgeted` : `Earned ${fmt(earnedAmount)}`;
    const spentPart = hasSpentBudget ? `spent ${fmt(spentAmount)} of ${fmt(budgetedSpent)} budgeted` : `spent ${fmt(spentAmount)}`;
    const bottomLine = bothBudgeted ? m.surplusLabel : earnedVsSpent(earnedAmount, spentAmount).verdict;
    return (
      <View style={styles.card} testID={testID} accessibilityLabel={`${earnedPart}, ${spentPart}. ${bottomLine}.`}>
        <Bar label="Earned" amount={earnedAmount} share={m.earnedShare} targetShare={hasEarnedBudget ? m.budgetedEarnedShare : undefined} budgetedAmount={hasEarnedBudget ? budgetedEarned : undefined} color={C.good} testID="earned-bar" />
        <Bar label="Spent" amount={spentAmount} share={m.spentShare} targetShare={hasSpentBudget ? m.budgetedSpentShare : undefined} budgetedAmount={hasSpentBudget ? budgetedSpent : undefined} color={C.bad} testID="spent-bar" />
        {bothBudgeted
          ? <Text testID="budgeted-surplus" style={styles.verdict}>{m.surplusLabel}</Text>
          : <Text testID="earned-vs-spent-verdict" style={styles.verdict}>{bottomLine}</Text>}
      </View>
    );
  }

  const { earnedShare, spentShare, verdict } = earnedVsSpent(earnedAmount, spentAmount);
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
  barSub: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, marginTop: 6, textAlign: 'right' },
  verdict: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textBright, textAlign: 'center', marginTop: 4 },
});
