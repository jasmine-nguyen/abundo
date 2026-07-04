import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, tint } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, categoryBreakdown } from '../../src/context';

export default function Insights() {
  const s = useAppContext();
  const insets = useSafeAreaInsets();
  const { rows, total } = categoryBreakdown(s);

  // Spend depends on the current cycle, so re-pull whenever the tab gains focus
  // (the window rolls over on payday, and categorising elsewhere moves the numbers).
  // Also pull any AI insights already cached for this cycle (free — no generation).
  useFocusEffect(useCallback(() => {
    s.refreshBreakdown();
    s.refreshAiInsights();
  }, [s.refreshBreakdown, s.refreshAiInsights]));

  const loading = s.breakdownLoading && rows.length === 0;
  const ai = s.aiInsights;
  const hasAi = !!(ai && (ai.summary || ai.suggestions.length > 0));

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.headerTitle}>Insights</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* hero: where the money went this cycle */}
        <View style={styles.hero}>
          <View style={styles.heroBlob} />
          <Text style={styles.heroEyebrow}>THIS PAY CYCLE</Text>
          <Text style={styles.heroTotal}>{fmt(total)}</Text>
          <Text style={styles.heroSub}>spent across {rows.length} {rows.length === 1 ? 'category' : 'categories'}</Text>
        </View>

        {/* AI: analyse this cycle's spend and suggest what to trim (WHIT-104) */}
        <View style={styles.aiCard}>
          <View style={styles.aiHeadRow}>
            <Icon name="star" size={18} color={C.accent} />
            <Text style={styles.aiTitle}>AI insights</Text>
          </View>

          {hasAi && !!ai?.summary && <Text style={styles.aiSummary}>{ai.summary}</Text>}
          {hasAi && ai!.suggestions.map((tip, i) => (
            <View key={i} style={styles.aiTipRow}>
              <Text style={styles.aiBullet}>•</Text>
              <Text style={styles.aiTip}>{tip}</Text>
            </View>
          ))}

          {!hasAi && !s.aiInsightsLoading && !s.aiInsightsError && (
            <Text style={styles.aiIdle}>Get a few AI suggestions on where to cut back this cycle.</Text>
          )}
          {s.aiInsightsError && (
            <Text style={styles.aiError}>Couldn’t generate insights. Please try again.</Text>
          )}

          <Pressable
            style={[styles.aiBtn, s.aiInsightsLoading && styles.aiBtnBusy]}
            disabled={s.aiInsightsLoading}
            onPress={() => s.generateAiInsights()}
          >
            {s.aiInsightsLoading
              ? <ActivityIndicator color={C.heroInk} />
              : <Text style={styles.aiBtnText}>{hasAi ? 'Re-analyse my spending' : 'Analyse my spending'}</Text>}
          </Pressable>

          <Text style={styles.aiNote}>Sends your category spend totals to Anthropic to generate advice. Suggestions, not financial advice.</Text>
        </View>

        {loading && <Text style={styles.empty}>Loading…</Text>}
        {!loading && rows.length === 0 && (
          <Text style={styles.empty}>No spending yet this pay cycle.</Text>
        )}

        {rows.map((r) => {
          // Bar width is the row's share of the cycle total; within it, split posted
          // vs pending so the pending portion reads distinctly.
          const postedW = r.spent > 0 ? r.pct * (r.posted / r.spent) : 0;
          const pendingW = Math.max(0, r.pct - postedW);
          return (
            <View key={r.id} style={styles.row}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                <View style={[styles.chip, { backgroundColor: r.chipBg }]}><Icon name={r.icon} size={23} color={r.color} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                  <Text style={styles.rowSub}>{r.spentLabel}</Text>
                </View>
                <Text style={styles.rowAmount}>{fmt(r.spent)}</Text>
              </View>
              <View style={styles.track}>
                <View style={{ width: `${postedW}%`, backgroundColor: r.color, height: '100%', borderRadius: 5 }} />
                {pendingW > 0 && (
                  <View style={{ width: `${pendingW}%`, backgroundColor: tint(r.color, 0.45), height: '100%', borderRadius: 5 }} />
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingBottom: 12 },
  headerTitle: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: '#fff', letterSpacing: -0.2 },

  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 24, paddingTop: 26, paddingBottom: 22, marginBottom: 22, backgroundColor: '#6f7bf0' },
  heroBlob: { position: 'absolute', right: -30, top: -30, width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(255,255,255,.12)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: 'rgba(20,18,50,.65)', letterSpacing: 0.2 },
  heroTotal: { fontFamily: FONT.display, fontSize: 40, fontWeight: '800', color: C.heroInk, letterSpacing: -1.5, marginTop: 4 },
  heroSub: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.heroInk2, marginTop: 2 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, paddingBottom: 14, marginBottom: 12 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: '#f1f1f4', letterSpacing: -0.4 },
  track: { flexDirection: 'row', gap: 2, height: 8, marginTop: 14, backgroundColor: 'rgba(255,255,255,.05)', borderRadius: 5, overflow: 'hidden' },

  empty: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, textAlign: 'center', paddingVertical: 40 },

  aiCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, marginBottom: 22 },
  aiHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  aiTitle: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.textBright, letterSpacing: -0.2 },
  aiSummary: { fontFamily: FONT.body, fontSize: 14, color: C.textBright, lineHeight: 20, marginBottom: 10 },
  aiTipRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  aiBullet: { fontFamily: FONT.body, fontSize: 14, color: C.accent, lineHeight: 20 },
  aiTip: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textDim, lineHeight: 20 },
  aiIdle: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, lineHeight: 20, marginBottom: 12 },
  aiError: { fontFamily: FONT.body, fontSize: 14, color: C.bad, lineHeight: 20, marginBottom: 12 },
  aiBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  aiBtnBusy: { opacity: 0.7 },
  aiBtnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.heroInk },
  aiNote: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, lineHeight: 16, marginTop: 10 },
});
