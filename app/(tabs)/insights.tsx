import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, tint, agoLabel } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
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
  const ago = agoLabel(ai?.generated_at);

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

        {/* AI: a "coach" card — analyse this cycle's spend and suggest what to trim
            (WHIT-104). Accent-tinted so it reads as advice, distinct from the plain
            category rows below but calmer than the hero above. */}
        <View style={styles.aiCard}>
          <View style={styles.aiHeadRow}>
            <View style={styles.aiHeadLeft}>
              <Text style={styles.aiEmoji}>👀</Text>
              <Text style={styles.aiTitle}>Worth a look</Text>
            </View>
            {/* Once an insight exists the re-run is a quiet stamp + refresh, not a big
                button — the card stays about the advice. Refresh spins while working. */}
            {hasAi && (
              <View style={styles.aiHeadRight}>
                {/* A failed re-run keeps the old advice below, but must SAY it failed
                    (not just silently stop) — the refresh stays tappable to retry. */}
                {s.aiInsightsError
                  ? <Text style={styles.aiStampErr}>Couldn’t refresh</Text>
                  : !!ago && <Text style={styles.aiStamp}>{ago}</Text>}
                {s.aiInsightsLoading
                  ? <ActivityIndicator testID="ai-refresh-busy" size="small" color={C.accentSoft} />
                  : <Pressable
                      onPress={() => s.generateAiInsights()}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel="Re-analyse my spending"
                    >
                      <Glyph name="refresh" size={17} color={C.accentSoft} />
                    </Pressable>}
              </View>
            )}
          </View>

          {hasAi && !!ai?.summary && <Text style={styles.aiSummary}>{ai.summary}</Text>}
          {hasAi && ai!.suggestions.map((tip, i) => (
            <View key={i} style={styles.aiTipRow}>
              <View style={styles.aiDiamond} />
              <Text style={styles.aiTip}>{tip}</Text>
            </View>
          ))}

          {!hasAi && !s.aiInsightsLoading && !s.aiInsightsError && (
            <Text style={styles.aiIdle}>Get a few AI suggestions on where to cut back this cycle.</Text>
          )}
          {!hasAi && s.aiInsightsError && (
            <Text style={styles.aiError}>Couldn’t generate insights. Please try again.</Text>
          )}

          {/* Big button only on first run / empty; re-runs use the header refresh. */}
          {!hasAi && (
            <Pressable
              style={[styles.aiBtn, s.aiInsightsLoading && styles.aiBtnBusy]}
              disabled={s.aiInsightsLoading}
              onPress={() => s.generateAiInsights()}
            >
              {s.aiInsightsLoading
                ? <ActivityIndicator color={C.heroInk} />
                : <Text style={styles.aiBtnText}>{s.aiInsightsError ? 'Try again' : 'Analyse my spending'}</Text>}
            </Pressable>
          )}

          {/* Full disclosure before the first send (conscious choice); a compact
              reminder once populated — but Anthropic is named in both. */}
          <Text style={styles.aiNote}>
            {hasAi
              ? 'Category spend totals sent to Anthropic. Suggestions, not financial advice.'
              : 'Sends your category spend totals to Anthropic to generate advice. Suggestions, not financial advice.'}
          </Text>
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

  // Coach card: a soft accent wash + accent hairline so it reads as "advice",
  // sitting between the loud hero and the plain category rows.
  aiCard: { backgroundColor: tint(C.accent, 0.07), borderWidth: 1, borderColor: tint(C.accent, 0.22), borderRadius: 20, padding: 16, marginBottom: 22 },
  aiHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  aiHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  aiEmoji: { fontSize: 15 },
  aiHeadRight: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 20 },
  aiTitle: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.textBright, letterSpacing: -0.2 },
  aiStamp: { fontFamily: FONT.body, fontSize: 12, color: C.textFaint },
  aiStampErr: { fontFamily: FONT.body, fontSize: 12, color: C.bad },
  aiSummary: { fontFamily: FONT.body, fontSize: 14, color: C.text, lineHeight: 20, marginBottom: 12 },
  aiTipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  aiDiamond: { width: 6, height: 6, backgroundColor: C.accent, transform: [{ rotate: '45deg' }], marginTop: 7 },
  aiTip: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textMid, lineHeight: 20 },
  aiIdle: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, lineHeight: 20, marginBottom: 12 },
  aiError: { fontFamily: FONT.body, fontSize: 14, color: C.bad, lineHeight: 20, marginBottom: 12 },
  aiBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  aiBtnBusy: { opacity: 0.7 },
  aiBtnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.heroInk },
  aiNote: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, lineHeight: 16, marginTop: 10 },
});
