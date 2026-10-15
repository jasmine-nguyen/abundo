import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, tint } from '../theme';
import { balanceFreshness } from '../dateutil';

// WHIT-822: "As of <day>" for the home-loan balance on a hero card; the dot turns amber once
// the balance is more than a few days old. Shared by /mortgage and /milestone. ABU-64: the
// 'card' tone reads on a plain dark card (the account page).
export function BalanceFreshnessPill({ asOf, tone = 'hero' }: { asOf: string | null; tone?: 'hero' | 'card' }) {
  const freshness = balanceFreshness(asOf);
  if (!freshness) return null;
  const onCard = tone === 'card';
  return (
    <View style={[styles.pill, onCard && styles.pillCard]} testID="balance-freshness">
      <View
        style={[styles.dot, { backgroundColor: freshness.stale ? C.warn : C.goodBright }]}
        testID={freshness.stale ? 'balance-freshness-stale' : undefined}
      />
      <Text style={[styles.text, onCard && styles.textCard]}>{freshness.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 7, backgroundColor: C.heroInkWash, borderRadius: 9, paddingVertical: 6, paddingHorizontal: 11, marginTop: 14 },
  pillCard: { backgroundColor: tint(C.textDim, 0.12), marginTop: 10 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.heroInk },
  textCard: { color: C.textMid },
});
