import { ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT } from '../theme';
import { Glyph } from '../icons';

// Owns its heading and subheading so Milestone and Mortgage can't drift apart.
export function EquityCard({ right, children }: { right?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.chip}><Glyph name="building" size={22} color={C.purple} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Equity for your next place</Text>
          <Text style={styles.sub}>Usable equity from your current home</Text>
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

export function EquityBody({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

// The purple button that opens the loan form.
export function EquityCta({ label }: { label: string }) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push('/loan')} style={styles.cta}>
      <Text style={styles.ctaText}>{label}</Text>
    </Pressable>
  );
}

// WHIT-821: no button — the Home loan screen's top card is the one place to set up.
export function EquitySetupTeaser() {
  return <EquityBody>Your usable equity will show here once your loan details are set up.</EquityBody>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13 },
  chip: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.purpleWash, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.textBright },
  sub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  body: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, lineHeight: 18, marginTop: 11 },
  cta: { alignSelf: 'flex-start', backgroundColor: C.purpleWash, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 14, marginTop: 12 },
  ctaText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.purple },
});
