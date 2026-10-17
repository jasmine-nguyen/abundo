import { Text, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

// ABU-66: a list's day heading — "Today · $42 spent" — shared by Transactions and the account page.
export function DayHeading({ label, dayTotal }: { label: string; dayTotal: string | null }) {
  let heading = label;
  if (dayTotal) heading = `${label} · ${dayTotal}`;
  return <Text style={styles.groupLabel} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{heading}</Text>;
}

const styles = StyleSheet.create({
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },
});
