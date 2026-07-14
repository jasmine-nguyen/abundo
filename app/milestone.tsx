import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmt } from '../src/theme';
import { Glyph } from '../src/icons';
import { milestoneView } from '../src/context';
import { useGoalScreenData } from '../src/queries';
import { Bar, RetryButton, HeroGradientFill } from '../src/components/ui';
import { Header } from '../src/components/Header';
import { MONTHS } from '../src/dateutil';

// "2027-03-18" -> "Mar 2027". Parsed by hand (no Date) so the label can't shift
// across a timezone boundary.
function monthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export default function Milestone() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // WHIT-197: the live balance + loan facts now come from the cached query layer.
  // Re-check on focus only when stale. `homeLoanError` is the balance read's OWN error
  // (not the aggregate) — a repayment/loanFacts failure must not show as a balance error.
  const { loanFacts, homeLoan, homeLoanError, refetch, refetchStale } = useGoalScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));
  const v = milestoneView({ loanFacts, homeLoan });

  const scheduleColor = !v.schedule
    ? C.textDim
    : v.schedule.onTrack || v.schedule.ahead
      ? C.good
      : C.warn;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Home loan plan" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {/* hero: current balance + schedule verdict */}
        <View style={styles.hero}>
          <HeroGradientFill />
          <View style={styles.heroBlob} />
          <Text style={styles.heroEyebrow}>HOME LOAN · BALANCE OWING</Text>
          {v.hasBalance ? (
            <>
              <Text style={styles.heroBig}>{v.balanceLabel}</Text>
              {v.schedule && (
                <View style={[styles.pill, { backgroundColor: 'rgba(21,18,58,.16)' }]}>
                  <View style={[styles.pillDot, { backgroundColor: scheduleColor }]} />
                  <Text style={styles.pillText}>{v.schedule.label}</Text>
                </View>
              )}
              <View style={{ marginTop: 16 }}>
                <Bar pct={v.overallPct} color={C.goodBright} track="rgba(21,18,58,.18)" height={12} />
              </View>
              <View style={styles.heroRow}>
                <Text style={styles.heroRowL}>{v.clearedCount} of {v.total} milestones reached</Text>
                <Text style={styles.heroRowR}>target {fmt(v.rows[v.rows.length - 1].targetBalance)}</Text>
              </View>
              {v.asOf && (
                <View style={styles.syncPill}>
                  <View style={styles.syncDot} />
                  <Text style={styles.syncText}>Live · Up Home Loan · {monthYear(v.asOf.slice(0, 10))}</Text>
                </View>
              )}
            </>
          ) : homeLoanError ? (
            <View style={styles.waiting}>
              <Text style={styles.waitingText} accessibilityLiveRegion="polite">Couldn't load your balance.</Text>
              <RetryButton onPress={() => refetch()} label="Retry loading your balance" testID="milestone-balance-retry" style={styles.retryBtn} textStyle={styles.retryText} />
            </View>
          ) : (
            <View style={styles.waiting}>
              <ActivityIndicator color={C.heroInk} />
              <Text style={styles.waitingText}>Fetching your live balance…</Text>
            </View>
          )}
        </View>

        {/* next milestone */}
        {v.hasBalance && v.nextMilestone && (
          <View style={styles.nextCard}>
            <Text style={styles.nextEyebrow}>NEXT MILESTONE</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
              <Text style={styles.nextBig}>under {fmt(v.nextMilestone.targetBalance)}</Text>
              <Text style={styles.nextTo}>{v.amountToNextLabel} to go</Text>
            </View>
            <Text style={styles.nextBody}>
              {v.nextMilestone.label} · by {monthYear(v.nextMilestone.targetDate)}. Every extra dollar off the principal pulls this closer. 🪓
            </Text>
          </View>
        )}

        {/* sprint track */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>The 36-month plan</Text>
          {v.rows.map((r) => (
            <View key={r.sprint} style={styles.row}>
              <View style={[styles.check, { backgroundColor: r.cleared ? 'rgba(53,217,160,.16)' : 'rgba(255,255,255,.06)' }]}>
                <Glyph name={r.cleared ? 'check' : 'target'} size={16} color={r.cleared ? C.good : C.textFaint} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>Sprint {r.sprint} · {r.label}</Text>
                <Text style={styles.rowSub}>under {fmt(r.targetBalance)} · {monthYear(r.targetDate)}</Text>
              </View>
              {/* per-sprint equity only once the property value + LVR are set */}
              {r.targetEquity != null && (
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.rowEquity}>{fmt(r.targetEquity)}</Text>
                  <Text style={styles.rowEquityLabel}>equity</Text>
                </View>
              )}
            </View>
          ))}
        </View>

        {/* usable equity for IP1 — real once the property value is set, else a prompt */}
        <View style={[styles.card, { marginBottom: 6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13 }}>
            <View style={styles.ipChip}><Glyph name="building" size={22} color={C.purple} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Investment property #2</Text>
              <Text style={styles.rowSub}>Usable equity toward a deposit</Text>
            </View>
          </View>
          {v.equityKnown ? (
            <>
              <View style={styles.equityHead}>
                <Text style={styles.equityBig}>{v.usableEquityLabel}</Text>
                <Text style={styles.equityHint}>at {fmt(v.propertyValue!)} value · {Math.round((loanFacts.lvr ?? 0) * 100)}% LVR</Text>
              </View>
              <Text style={styles.ipBody}>Usable equity = your LVR × the property value, minus what you still owe. Kill more principal, unlock more deposit. 📈</Text>
            </>
          ) : (
            <>
              <Text style={styles.ipBody}>Add your property value to see how much equity you could unlock toward your next place.</Text>
              <Pressable onPress={() => router.push('/loan')} style={styles.equityCta}>
                <Text style={styles.equityCtaText}>Add loan details →</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 22, paddingBottom: 20, marginBottom: 14, backgroundColor: C.accent },
  heroBlob: { position: 'absolute', right: -26, top: -26, width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(255,255,255,.1)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: 'rgba(20,18,50,.62)', letterSpacing: 0.3 },
  heroBig: { fontFamily: FONT.display, fontSize: 44, fontWeight: '800', color: C.heroInk, lineHeight: 46, letterSpacing: -1.6, marginTop: 6 },
  heroRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 9 },
  heroRowL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.heroInk2 },
  heroRowR: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
  pill: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 7, borderRadius: 9, paddingVertical: 6, paddingHorizontal: 11, marginTop: 12 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.heroInk },
  syncPill: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 7, backgroundColor: 'rgba(21,18,58,.16)', borderRadius: 9, paddingVertical: 6, paddingHorizontal: 11, marginTop: 14 },
  syncDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.goodBright },
  syncText: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.heroInk },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  waitingText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.heroInk },
  retryBtn: { backgroundColor: 'rgba(21,18,58,.16)', borderRadius: 9, paddingVertical: 6, paddingHorizontal: 14 },
  retryText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.heroInk },

  nextCard: { backgroundColor: 'rgba(124,140,255,.1)', borderWidth: 1, borderColor: 'rgba(124,140,255,.22)', borderRadius: 18, padding: 16, marginBottom: 12 },
  nextEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSofter },
  nextBig: { fontFamily: FONT.display, fontSize: 26, fontWeight: '800', color: '#fff', letterSpacing: -0.8 },
  nextTo: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSoft },
  nextBody: { fontFamily: FONT.body, fontSize: 13, color: '#a6a6b0', lineHeight: 19, marginTop: 6 },

  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 12 },
  cardTitle: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.textBright, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  check: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.textBright },
  rowSub: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, marginTop: 2 },
  rowEquity: { fontFamily: FONT.display, fontSize: 15, fontWeight: '800', color: C.purple },
  rowEquityLabel: { fontFamily: FONT.body, fontSize: 10.5, color: C.textFaint, marginTop: 1 },

  ipChip: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(201,179,245,.16)', alignItems: 'center', justifyContent: 'center' },
  equityHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  equityBig: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: '#d9c9f7', letterSpacing: -0.6 },
  equityHint: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },
  ipBody: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, lineHeight: 18, marginTop: 11 },
  equityCta: { alignSelf: 'flex-start', backgroundColor: 'rgba(201,179,245,.16)', borderRadius: 11, paddingVertical: 9, paddingHorizontal: 14, marginTop: 12 },
  equityCtaText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.purple },
});
