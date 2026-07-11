import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmt } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { balanceGoalView } from '../../src/context';
import { useGoalsScreenData } from '../../src/queries';
import { MONTHS } from '../../src/dateutil';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { Bar, RetryButton } from '../../src/components/ui';

// "2026-08-15" -> "Aug 2026". Parsed by hand (no Date) so the label can't shift across a
// timezone boundary. Falls back to the raw ISO if it's somehow unparseable.
function byLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : iso;
}

// WHIT-233: the Goals hub — the tab formerly showing only the mortgage. Lists the user's
// savings/debt goals (each a progress + pace card off the pure balanceGoalView engine) and
// keeps the home loan as its own always-present card that taps into the full mortgage screen
// (relocated to app/mortgage). Adding/editing a goal is a later card; the "+" and the empty
// state route to the /goal/edit stub for now.
export default function Goals() {
  const router = useRouter();
  const { goals, payCycle, balanceFor, homeLoan, mortgageError, isLoading, isError, refetch, refetchStale } = useGoalsScreenData();

  // Load-on-focus, staleness-gated (like Budgets) so tab-hopping doesn't refetch every tap.
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // Cache-first: keep showing goals while a background refetch runs; error takes precedence
  // over the spinner so a failed read never sits under an endless spinner with no Retry. Both
  // gate on the PRIMARY status (goals + pay cycle) — a mortgage/balance hiccup is secondary and
  // shows per-card, never blanking the hub.
  const showError = isError && goals.length === 0;
  const showSpinner = !showError && isLoading && goals.length === 0;

  return (
    <ScrollChromeHeader
      title="Goals"
      right={(
        <Pressable testID="add-goal" onPress={() => router.push('/goal/edit')} style={styles.addBtn}>
          <Glyph name="plus" size={22} color={C.accentSoft} />
        </Pressable>
      )}
      contentContainerStyle={(showSpinner || showError) ? styles.fill : undefined}
    >
      {showSpinner ? (
        <View testID="goals-loading" style={styles.centered}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : showError ? (
        <View testID="goals-error" style={styles.centered}>
          <Text style={styles.errorText}>Couldn't load your goals.</Text>
          <RetryButton onPress={refetch} label="Retry loading your goals" testID="goals-retry" style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      ) : (
        <>
          {/* The mortgage — always shown (its own big goal), taps into the full payoff screen. */}
          <Pressable testID="mortgage-link" onPress={() => router.push('/mortgage')} style={styles.mortgageCard}>
            <View style={styles.mortgageChip}><Glyph name="building" size={22} color={C.heroInk} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.mortgageTitle}>The mortgage</Text>
              <Text style={styles.mortgageSub}>
                {homeLoan.balance != null
                  ? `${fmt(homeLoan.balance)} owing`
                  : mortgageError
                    ? 'Tap to open your payoff plan'
                    : 'Tap to see your payoff plan'}
              </Text>
            </View>
            <Glyph name="chevron" size={16} color="rgba(20,18,50,.55)" />
          </Pressable>

          <Text style={styles.sectionLabel}>YOUR GOALS</Text>

          {goals.length === 0 ? (
            <View testID="goals-empty" style={styles.emptyCard}>
              <View style={styles.emptyChip}><Glyph name="target" size={24} color={C.accentSoft} /></View>
              <Text style={styles.emptyTitle}>No goals yet</Text>
              <Text style={styles.emptyBody}>
                Set a savings target or a debt to pay down, and we'll show how far you've come and how much to put aside each payday.
              </Text>
            </View>
          ) : (
            goals.map((goal) => {
              const v = balanceGoalView({ goal, balance: balanceFor(goal.account_id), payCycle });
              const pct = v.progress != null ? Math.round(v.progress * 100) : null;
              const grow = goal.direction === 'grow';
              return (
                <Pressable
                  key={goal.id}
                  testID={`goal-card-${goal.id}`}
                  onPress={() => router.push(`/goal/edit?id=${encodeURIComponent(goal.id)}`)}
                  style={styles.goalCard}
                >
                  <View style={styles.goalHead}>
                    <View style={styles.goalChip}><Icon name={goal.icon} size={22} color={C.accentSoft} /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.goalName} numberOfLines={1}>{goal.name}</Text>
                      <Text style={styles.goalSub}>
                        {grow ? 'Saving toward' : 'Paying down'} {fmt(goal.target_amount)} · by {byLabel(goal.target_date)}
                      </Text>
                    </View>
                    <Text style={styles.goalPct}>{pct != null ? `${pct}%` : '—'}</Text>
                  </View>

                  <View style={{ marginTop: 13 }}>
                    <Bar pct={pct ?? 0} color={grow ? C.goodBright : C.purple} height={10} />
                  </View>

                  <View style={styles.goalFoot}>
                    <Text style={styles.goalFootL}>
                      {v.pacePerPayday != null ? `${fmt(v.pacePerPayday)} / payday` : 'Waiting on your balance'}
                    </Text>
                    <Text style={styles.goalFootR}>
                      {v.paydaysLeft > 0 ? `${v.paydaysLeft} payday${v.paydaysLeft === 1 ? '' : 's'} left` : 'due now'}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}

          <Pressable testID="add-goal-cta" onPress={() => router.push('/goal/edit')} style={styles.addGoal}>
            <Glyph name="plus" size={18} color={C.accentSoft} />
            <Text style={styles.addGoalText}>Add a goal</Text>
          </Pressable>
        </>
      )}
    </ScrollChromeHeader>
  );
}

const styles = StyleSheet.create({
  // Grows the ScrollView content so the spinner/error state centres mid-viewport (WHIT-199).
  fill: { flexGrow: 1 },
  addBtn: { width: 40, height: 40, backgroundColor: 'rgba(124,140,255,.16)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // The mortgage entry — a light hero-tinted card so it reads as the headline goal.
  mortgageCard: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: '#6470de', borderRadius: 20, padding: 18, marginBottom: 20 },
  mortgageChip: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(21,18,58,.16)', alignItems: 'center', justifyContent: 'center' },
  mortgageTitle: { fontFamily: FONT.display, fontSize: 17, fontWeight: '800', color: C.heroInk, letterSpacing: -0.3 },
  mortgageSub: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.heroInk2, marginTop: 2 },

  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textDim, letterSpacing: 0.5, marginBottom: 12, marginLeft: 2 },

  goalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 12 },
  goalHead: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  goalChip: { width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(124,140,255,.14)', alignItems: 'center', justifyContent: 'center' },
  goalName: { fontFamily: FONT.body, fontSize: 15.5, fontWeight: '700', color: C.textBright, letterSpacing: -0.2 },
  goalSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  goalPct: { fontFamily: FONT.display, fontSize: 18, fontWeight: '800', color: C.text, letterSpacing: -0.5 },
  goalFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 11 },
  goalFootL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.accentSoft },
  goalFootR: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },

  emptyCard: { alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 24, marginBottom: 12 },
  emptyChip: { width: 52, height: 52, borderRadius: 16, backgroundColor: 'rgba(124,140,255,.14)', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 17, fontWeight: '800', color: C.textBright, letterSpacing: -0.3 },
  emptyBody: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, lineHeight: 19, textAlign: 'center', marginTop: 6 },

  addGoal: { marginTop: 8, marginBottom: 6, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', backgroundColor: 'rgba(124,140,255,.07)', borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addGoalText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 16 },
  errorText: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 11, paddingHorizontal: 24, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
