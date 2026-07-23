import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, fmt } from '../theme';

// WHIT-312/324: an "earned vs spent" read for the selected pay cycle — two horizontal bars
// (earned in the app's positive teal, spent in the overspend coral) on ONE shared ruler, so the
// bigger amount fills the bar and the smaller is proportional. Below them, a single line states the
// cycle's surplus or deficit. WHIT-324 removed the earlier budgeted overlay: this card's one job is
// the surplus/deficit read; budget-vs-actual lives in the per-category bars lower on the screen.

// A tiny spend against a large income rounds to a near-invisible bar; floor the smaller bar's width
// so it stays a visible nub. A full bar (share 1) and an empty bar (share 0) are unaffected.
const MIN_BAR_SHARE = 0.03;

const TONE_COLOR = { good: C.surplus, bad: C.bad, neutral: C.textBright } as const;

// Coerce a non-finite input (a hand-mocked screen can pass `undefined`) to 0 rather than
// spilling NaN into a bar width.
const num = (v: number): number => (Number.isFinite(v) ? v : 0);

// The earned-vs-spent read, pure + exported so a test pins every branch without rendering. `share`
// is each amount over the larger of the two (the shared ruler). `amountLabel` is the bold signed
// headline ("+$4,666 surplus" / "−$500 deficit" / "$0"), `message` the sentence beside it, and
// `tone` the amount's colour. A unicode minus (−) keeps the deficit reading clean.
export function earnedVsSpent(earned: number, spent: number): {
  leftover: number; overspent: boolean; even: boolean;
  earnedShare: number; spentShare: number;
  amountLabel: string; message: string; tone: keyof typeof TONE_COLOR;
} {
  const earnedAmount = num(earned);
  const spentAmount = num(spent);
  const leftover = earnedAmount - spentAmount;
  // Classify + label on the WHOLE-DOLLAR amount the card actually shows (fmt rounds to dollars), so
  // a sub-dollar gap that displays as "$0" reads as broke-even — never a contradictory
  // "+$0 surplus 🎉". Using the same rounded value for both keeps the word and the number in step.
  const rounded = Math.round(leftover);
  const even = rounded === 0;
  const overspent = rounded < 0;
  const max = Math.max(earnedAmount, spentAmount);
  const earnedShare = max > 0 ? earnedAmount / max : 0;
  const spentShare = max > 0 ? spentAmount / max : 0;

  let amountLabel: string, message: string, tone: keyof typeof TONE_COLOR;
  if (even) {
    amountLabel = fmt(0);
    message = 'You broke even this cycle.';
    tone = 'neutral';
  } else if (overspent) {
    amountLabel = `−${fmt(rounded)} deficit`;
    message = "oops, a little over this cycle. You've got the next one to balance it out. 💪";
    tone = 'bad';
  } else {
    amountLabel = `+${fmt(rounded)} surplus`;
    message = 'Nice, you earned more than you spent this cycle. 🎉';
    tone = 'good';
  }

  return { leftover, overspent, even, earnedShare, spentShare, amountLabel, message, tone };
}

// One labelled bar: the amount, then a proportional fill on the shared ruler. A non-zero share is
// floored to MIN_BAR_SHARE so a tiny bar never vanishes; a zero share stays empty.
function Bar({ label, amount, share, color, testID }: {
  label: string; amount: number; share: number; color: string; testID: string;
}) {
  const pct = share > 0 ? Math.max(share, MIN_BAR_SHARE) * 100 : 0;
  return (
    <View style={styles.barBlock}>
      <View style={styles.barHead}>
        <Text style={styles.barLabel}>{label}</Text>
        <Text style={[styles.barAmount, { color }]}>{fmt(amount)}</Text>
      </View>
      <View style={styles.track}>
        <View testID={testID} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: color, borderRadius: 5 }} />
      </View>
    </View>
  );
}

// The earned-vs-spent card: two bars on the shared ruler + a surplus/deficit line. Renders nothing
// when there was neither income nor spend — the screen shows its own empty state instead.
export function EarnedVsSpent({ earned, spent, testID }: {
  earned: number; spent: number; testID?: string;
}) {
  const earnedAmount = num(earned);
  const spentAmount = num(spent);
  if (earnedAmount <= 0 && spentAmount <= 0) return null;

  const { earnedShare, spentShare, amountLabel, message, tone } = earnedVsSpent(earnedAmount, spentAmount);
  const label = `Earned ${fmt(earnedAmount)}, spent ${fmt(spentAmount)}. ${amountLabel} — ${message}`;
  return (
    <View style={styles.card} testID={testID} accessibilityLabel={label}>
      <Bar label="Earned" amount={earnedAmount} share={earnedShare} color={C.good} testID="earned-bar" />
      <Bar label="Spent" amount={spentAmount} share={spentShare} color={C.bad} testID="spent-bar" />
      <View style={styles.summary}>
        <Text style={styles.summaryLine}>
          <Text testID="earned-vs-spent-amount" style={[styles.summaryAmount, { color: TONE_COLOR[tone] }]}>{amountLabel}</Text>
          <Text testID="earned-vs-spent-message" style={styles.summaryMessage}>{` — ${message}`}</Text>
        </Text>
      </View>
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
  summary: { marginTop: 4, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.hairline },
  summaryLine: { textAlign: 'left' },
  summaryAmount: { fontFamily: FONT.display, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  summaryMessage: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.textDim },
});
