import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator, Animated } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmt } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { budgetViews } from '../../src/context';
import { useBudgetsScreenData } from '../../src/queries';
import { useNavBarsHeader, floatingHeaderStyle } from '../../src/motion/useNavBarsHeader';
import { WhittleBar } from '../../src/components/ui';

export default function Budgets() {
  const router = useRouter();
  // WHIT-188: data now comes from the cached, auth-gated, self-healing query layer
  // instead of the eager global store. A transient 5xx retries with backoff (no stuck
  // banner); the inline error/retry below is the local fallback for a sustained failure.
  const { budgets, category, cycleLen, daysLeft, isLoading, isError, payCycleError, refetch, refetchStale } = useBudgetsScreenData();

  // Load-on-focus: refresh when the tab regains focus, but only if the data has gone
  // stale (the window rolls over on payday; a save/categorise elsewhere moves numbers).
  // Staleness-gated so hopping between tabs doesn't refetch on every tap.
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  const { rows, totBudget, totSpent, totRemain } = budgetViews({ budgets, category, cycleLen, daysLeft });

  // Cache-first: once we have any rows, keep showing them while a background refetch
  // runs. Error takes precedence over the spinner — a failed read must never sit under an
  // endless spinner with no Retry (code-critic/qa #1). WHIT-72: also error out when the pay
  // cycle failed to load at all (payCycleError) — budgets now fetch in parallel, so without
  // this the rows would render against the DEFAULT cycle (a wrong days-left + pace bars).
  const showError = (isError && rows.length === 0) || payCycleError;
  const showSpinner = !showError && isLoading && rows.length === 0;

  // Scroll-to-hide the nav bars (WHIT-184): header floats over the list and slides up on
  // scroll-down; the list is inset so nothing sits under the bars at rest. All geometry
  // (header height, top/bottom insets, scroll wiring) comes from the shared hook.
  const { onScroll, scrollEventThrottle, headerStyle, headerPaddingTop, contentPadding } = useNavBarsHeader();

  return (
    <View style={{ flex: 1 }}>
      <Animated.View style={[floatingHeaderStyle, { paddingTop: headerPaddingTop }, headerStyle]}>
        <View style={{ width: 40 }} />
        <Text style={styles.headerTitle}>Budgets</Text>
        <Pressable onPress={() => router.push('/budget/pick')} style={styles.addBtn}>
          <Glyph name="plus" size={22} color={C.accentSoft} />
        </Pressable>
      </Animated.View>

      {showSpinner ? (
        <View testID="budgets-loading" style={styles.centered}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : showError ? (
        <View testID="budgets-error" style={styles.centered}>
          <Text style={styles.errorText}>Couldn't load your budgets.</Text>
          <Pressable testID="budgets-retry" onPress={refetch} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingHorizontal: 18, ...contentPadding }}
        showsVerticalScrollIndicator={false}>
        {/* hero */}
        <View style={styles.hero}>
          <View style={styles.heroBlob1} />
          <View style={styles.heroBlob2} />
          <Text style={styles.heroEyebrow}>THIS PAY CYCLE</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
            <Text style={styles.heroDays}>{daysLeft}</Text>
            <Text style={styles.heroDaysLabel}>days left</Text>
          </View>
          <View style={styles.heroBottom}>
            <View>
              <Text style={styles.heroSmall}>Budget remaining</Text>
              <Text style={styles.heroRemain}>{fmt(totRemain)}</Text>
            </View>
            <View style={styles.heroPill}>
              <Text style={styles.heroPillTop}>of {fmt(totBudget)}</Text>
              <Text style={styles.heroPillBot}>{fmt(totSpent)} spent</Text>
            </View>
          </View>
        </View>

        {/* legend */}
        <View style={styles.legend}>
          <View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: '#9aa2b5' }]} /><Text style={styles.legendText}>Posted</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: 'rgba(154,162,181,.5)' }]} /><Text style={styles.legendText}>Pending</Text></View>
          <View style={[styles.legendItem, { marginLeft: 'auto' }]}><View style={{ width: 2, height: 13, backgroundColor: '#fff' }} /><Text style={styles.legendText}>Today's pace</Text></View>
        </View>

        {rows.map((b) => (
          <Pressable key={b.id} onPress={() => router.push(`/budget/${b.id}`)} style={styles.row}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 13 }}>
              <View style={[styles.chip, { backgroundColor: b.chipBg }]}><Icon name={b.icon} size={23} color={b.color} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowName}>{b.name}</Text>
                <Text style={styles.rowSub}>{b.spentLabel}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.rowRemain, { color: b.remainColor }]}>{b.remainAmount}</Text>
                <Text style={styles.rowRemainLabel}>{b.remainLabel}</Text>
              </View>
            </View>
            <View style={{ marginTop: 15 }}>
              <WhittleBar postedPct={b.postedPct} pendingPct={b.pendingPct} targetPct={b.targetPct} postedColor={b.postedColor} pendingTint={b.pendingTint} />
              <View style={styles.paceRow}>
                <Text style={[styles.paceTarget, { left: `${b.targetPct}%` }]}>target</Text>
                <Text style={[styles.paceLabel, { color: b.paceColor }]}>{b.paceLabel}</Text>
              </View>
            </View>
          </Pressable>
        ))}

        <Pressable onPress={() => router.push('/budget/pick')} style={styles.addBudget}>
          <Glyph name="plus" size={18} color={C.accentSoft} />
          <Text style={styles.addBudgetText}>Add a budget</Text>
        </Pressable>
      </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: '#fff', letterSpacing: -0.2 },
  addBtn: { width: 40, height: 40, backgroundColor: 'rgba(124,140,255,.16)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 24, paddingTop: 26, paddingBottom: 22, marginBottom: 22, backgroundColor: '#6f7bf0' },
  heroBlob1: { position: 'absolute', right: -30, top: -30, width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(255,255,255,.12)' },
  heroBlob2: { position: 'absolute', right: 34, bottom: -46, width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(255,255,255,.08)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: 'rgba(20,18,50,.65)', letterSpacing: 0.2 },
  heroDays: { fontFamily: FONT.display, fontSize: 54, fontWeight: '800', color: C.heroInk, letterSpacing: -2, lineHeight: 54 },
  heroDaysLabel: { fontFamily: FONT.body, fontSize: 17, fontWeight: '600', color: C.heroInk2 },
  heroBottom: { marginTop: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  heroSmall: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
  heroRemain: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.heroInk, letterSpacing: -1, marginTop: 2 },
  heroPill: { alignItems: 'flex-end', backgroundColor: 'rgba(21,18,58,.12)', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 },
  heroPillTop: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
  heroPillBot: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.heroInk, marginTop: 2 },

  legend: { flexDirection: 'row', alignItems: 'center', gap: 16, marginHorizontal: 4, marginBottom: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  legendSwatch: { width: 18, height: 9, borderRadius: 3 },
  legendText: { fontFamily: FONT.body, fontSize: 12, color: '#8b8b95', fontWeight: '500' },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, paddingBottom: 14, marginBottom: 12 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowRemain: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  rowRemainLabel: { fontFamily: FONT.body, fontSize: 11, color: C.textDim, fontWeight: '500', marginTop: 1 },
  paceRow: { position: 'relative', height: 18, marginTop: 1 },
  paceTarget: { position: 'absolute', top: 5, transform: [{ translateX: -16 }], fontFamily: FONT.body, fontSize: 10, color: '#73737d', fontWeight: '500' },
  paceLabel: { position: 'absolute', top: 3, right: 0, fontFamily: FONT.body, fontSize: 11.5, fontWeight: '700' },

  addBudget: { marginTop: 8, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', backgroundColor: 'rgba(124,140,255,.07)', borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addBudgetText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 16 },
  errorText: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 11, paddingHorizontal: 24, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
