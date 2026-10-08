import React, { useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect, useIsFocused } from 'expo-router';
import { C, FONT, fmt, tint, PRESSED } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { balanceGoalView, goalView, milestoneView, useAppContext } from '../../src/context';
import { useGoalsScreenData } from '../../src/queries';
import { useCheckpointCelebration } from '../../src/hooks/useCheckpointCelebration';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { GoalSteps, stepKey } from '../../src/checkpointCelebration';
import { checkpointProgress } from '../../src/checkpoints';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { RetryButton, HeroGradientFill, HeaderIconButton } from '../../src/components/ui';
import { SettingsButton } from '../../src/components/SettingsButton';
import { Celebration } from '../../src/components/Celebration';
import { PayoffSummary } from '../../src/components/PayoffSummary';
import { GoalProgress, GoalHead, GoalBalanceRow } from '../../src/components/GoalProgress';

// WHIT-233: the Goals hub — the tab formerly showing only the mortgage. Lists the user's
// savings/debt goals (each a progress + pace card off the pure balanceGoalView engine) and
// keeps the home loan as its own always-present card that taps into the full mortgage screen
// (relocated to app/mortgage). Tapping a goal opens its read-only page (app/goal/[id], WHIT-749);
// the "+" and the empty state route to /goal/edit to add one.
export default function Goals() {
  const router = useRouter();
  const s = useAppContext(); // openGoalBalance — the in-place manual-balance update sheet (WHIT-235)
  const {
    goals, payCycle, balanceFor, loanFacts, homeLoan, homeLoanLoaded, mortgageError, milestones, milestonesLoaded, goalsLoaded,
    isLoading, isError, refetch, refetchStale,
  } = useGoalsScreenData();

  // WHIT-296: the mortgage card mirrors the /mortgage hero's payoff detail (paid-down figure,
  // % gone, progress bar, balance-to-go) — but only once there's genuine progress to show.
  // A balance at or above the original (a fresh loan, or a redraw/refinance that grew it) has
  // nothing honest to put in a "paid down" card, so it falls through to the plain "owing" line.
  const mortgage = goalView({ loanFacts, homeLoan });
  const paidDown = mortgage.paidOff ?? 0;
  // Shared gate (WHIT-372): goalView.paidDownReady is the one "genuine paydown to show?" flag both
  // this card and the /mortgage hero read — a sub-dollar paydown rounds to "$0" and has no honest
  // headline, so it stays on the plain "owing" line.
  const mortgageRich = mortgage.paidDownReady;
  // WHIT-821: the balance check worked but found nothing, and nothing's set up → no home loan.
  const noHomeLoan = homeLoanLoaded && homeLoan.balance == null && !mortgage.factsReady;

  // Load-on-focus, staleness-gated (like Budgets) so tab-hopping doesn't refetch every tap.
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // Each goal's view computed once — the cards below AND the WHIT-481 confetti hook read it.
  // Memoised so a plain redraw keeps the same identity while a real balance change (a new
  // balanceFor) recomputes it.
  const goalViews = useMemo(
    () => goals.map((goal) => ({ goal, view: balanceGoalView({ goal, balance: balanceFor(goal.account_id), payCycle }) })),
    [goals, balanceFor, payCycle],
  );

  // WHIT-481 / WHIT-747 / WHIT-811: the in-app confetti. Each goal's steps (its checkpoints, then
  // the target as the final step) and the mortgage's milestones go to the hook keyed by id, which
  // compares them with the copy saved on the phone and bursts when a known step is newly reached —
  // so a crossing that happened while the app was closed, or while another tab was open, celebrates
  // the next time Goals is in view.
  const isFocused = useIsFocused();
  const celebrationGoals = useMemo((): GoalSteps[] => {
    const goalSteps = goalViews.map(({ goal, view }): GoalSteps => {
      if (view.targetReached === null) return { id: goal.id, steps: null };
      const checkpointSteps = checkpointProgress(goal.checkpoints ?? [], goal.direction, view).rows.map(
        ({ checkpoint: cp, reached }) => ({
          key: stepKey(cp.id, cp.amount),
          reached: reached ?? false,
          label: `${goal.name} · ${cp.label} reached`,
        }),
      );
      const targetStep = {
        key: stepKey('target', goal.target_amount),
        reached: view.targetReached,
        label: `${goal.name} · goal reached`,
      };
      return { id: goal.id, steps: [...checkpointSteps, targetStep] };
    });
    const plan = milestoneView({ loanFacts, homeLoan, milestones });
    let mortgageSteps: GoalSteps['steps'] = null;
    if (plan.hasBalance && plan.hasPlan) {
      mortgageSteps = plan.rows.map((row) => ({
        key: stepKey(row.id, row.targetBalance),
        reached: row.cleared,
        label: `Home loan · ${row.label} reached`,
      }));
    }
    return [...goalSteps, { id: 'mortgage', steps: mortgageSteps }];
  }, [goalViews, loanFacts, homeLoan, milestones]);
  const celebrationReady = isFocused && goalsLoaded && !isLoading && milestonesLoaded;
  const { celebrationKey, label, onDone } = useCheckpointCelebration(celebrationGoals, celebrationReady);

  // Cache-first: keep showing goals while a background refetch runs; error takes precedence
  // over the spinner so a failed read never sits under an endless spinner with no Retry. Both
  // gate on the PRIMARY status (goals + pay cycle) — a mortgage/balance hiccup is secondary and
  // shows per-card, never blanking the hub.
  const showError = isError && goals.length === 0;
  const showSpinner = !showError && isLoading && goals.length === 0;
  // WHIT-814: a pull reloads goals, pay cycle, mortgage and balances.
  const { pulling, onRefresh } = usePullToRefresh(refetch);

  return (
    <>
    <ScrollChromeHeader
      title="Goals"
      left={<SettingsButton />}
      right={<HeaderIconButton testID="add-goal" icon="plus" accessibilityLabel="Add goal" onPress={() => router.push('/goal/edit')} />}
      // Always fill the viewport, so a short goal list is still a pull-to-refresh target.
      contentContainerStyle={styles.fill}
      refreshing={pulling && !showSpinner}
      onRefresh={onRefresh}
    >
      {showSpinner ? (
        <View testID="goals-loading" style={styles.centered}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : showError ? (
        <View testID="goals-error" style={styles.centered}>
          <Text style={styles.errorText}>Couldn't load your goals.</Text>
          <RetryButton onPress={refetch} label="Retry loading your goals" testID="goals-retry" />
        </View>
      ) : (
        <>
          {/* WHIT-295: the mortgage is your HEADLINE goal, so it lives INSIDE "YOUR GOALS" as the
              first card (label moved above it). Because it's always here, the hub never claims
              "no goals" while your biggest debt sits right in front of you. Taps into the payoff screen. */}
          <Text style={styles.sectionLabel}>YOUR GOALS</Text>

          {/* One tap target / route for the card; the rich payoff layout and the plain "owing"
              line are just different bodies + card style off mortgageRich. */}
          <Pressable
            testID="mortgage-link"
            onPress={() => router.push('/mortgage')}
            style={({ pressed }) => [mortgageRich ? styles.mortgageCardRich : styles.mortgageCardPlain, pressed && PRESSED]}
          >
            <HeroGradientFill />
            {mortgageRich ? (
              <>
                <View style={styles.mortgageRichHead}>
                  <View style={styles.mortgageChip}><Glyph name="building" size={22} color={C.heroInk} /></View>
                  <Text style={[styles.mortgageTitle, { flex: 1 }]}>Home loan</Text>
                  <Glyph name="chevron" size={16} color={C.heroInkSoft} />
                </View>
                <PayoffSummary
                  variant="card"
                  paidOff={paidDown}
                  paidPctLabel={mortgage.paidPctLabel}
                  paidPct={mortgage.paidPct}
                  balanceLabel={mortgage.balanceLabel}
                  original={mortgage.original!}
                />
              </>
            ) : (
              <>
                {/* WHIT-488: the /mortgage detail hero tile copied over — eyebrow + big balance,
                    minus the set-up body + button. The taller tile spreads the gradient (no band). */}
                <View style={styles.mortgageBlob} />
                <View style={styles.mortgageEyebrowRow}>
                  <Text style={styles.mortgageEyebrow}>{noHomeLoan ? 'YOUR HOME LOAN' : 'YOUR HOME LOAN · BALANCE OWING'}</Text>
                  <Glyph name="chevron" size={16} color={C.heroInkSoft} />
                </View>
                {noHomeLoan ? (
                  <Text testID="mortgage-no-home-loan" style={styles.mortgageFallback}>No home loan found in your linked accounts</Text>
                ) : homeLoan.balance != null ? (
                  <Text testID="mortgage-owing" style={[styles.mortgageBig, { marginTop: 6 }]}>
                    {fmt(homeLoan.balance)}
                  </Text>
                ) : (
                  <Text style={styles.mortgageFallback}>
                    {mortgageError ? 'Tap to open your payoff plan' : 'Tap to see your payoff plan'}
                  </Text>
                )}
              </>
            )}
          </Pressable>

          {goals.length === 0 ? (
            // WHIT-295: no "No goals yet" card — the mortgage above IS a goal. Just a short additive
            // invite to track more alongside it. WHIT-814: the dashed add row shows only here; with
            // goals, the header "+" is the one add button.
            <>
              <Text testID="goals-empty-hint" style={styles.emptyHint}>
                Your home loan is your first goal. Add a savings target or another debt to pay down, and we'll show how far you've come and how much to set aside each payday.
              </Text>
              <Pressable testID="add-goal-cta" onPress={() => router.push('/goal/edit')} style={styles.addGoal}>
                <Glyph name="plus" size={18} color={C.accentSoft} />
                <Text style={styles.addGoalText}>Add a goal</Text>
              </Pressable>
            </>
          ) : (
            goalViews.map(({ goal, view: v }) => {
              const editGoal = () => router.push(`/goal/edit?id=${encodeURIComponent(goal.id)}`);
              return (
                <Pressable
                  key={goal.id}
                  testID={`goal-card-${goal.id}`}
                  onPress={() => router.push(`/goal/${encodeURIComponent(goal.id)}`)}
                  style={({ pressed }) => [styles.goalCard, pressed && PRESSED]}
                >
                  <GoalHead goal={goal} view={v} chevron />
                  <GoalProgress goal={goal} view={v} onPastDue={editGoal} />
                  <GoalBalanceRow goal={goal} onUpdate={() => s.openGoalBalance(goal.id)} />
                </Pressable>
              );
            })
          )}
        </>
      )}
    </ScrollChromeHeader>
    {/* WHIT-481: the confetti overlay, a pointerEvents="none" absolute fill sibling to the header
        so it paints over the whole tab (which fills the viewport) without blocking taps beneath. */}
    <Celebration celebrationKey={celebrationKey} label={label} onDone={onDone} />
    </>
  );
}

const styles = StyleSheet.create({
  // Grows the ScrollView content so the spinner/error state centres mid-viewport (WHIT-199).
  fill: { flexGrow: 1 },

  // The mortgage entry — a light hero-tinted card so it reads as the headline goal.
  mortgageChip: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.heroInkWash, alignItems: 'center', justifyContent: 'center' },
  mortgageTitle: { fontFamily: FONT.display, fontSize: 17, fontWeight: '800', color: C.heroInk, letterSpacing: -0.3 },
  // WHIT-488: the plain card IS the /mortgage detail hero tile (taller than the rich card so the
  // gradient spreads smoothly instead of banding). Eyebrow + blob + big figure copied 1:1 from it.
  mortgageCardPlain: { position: 'relative', overflow: 'hidden', backgroundColor: C.accent, borderRadius: 26, padding: 22, paddingBottom: 20, marginBottom: 20 },
  mortgageBlob: { position: 'absolute', right: -26, top: -26, width: 140, height: 140, borderRadius: 70, backgroundColor: C.heroBlobFill },
  mortgageEyebrowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mortgageEyebrow: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.heroInkSoft, letterSpacing: 0.3 },
  mortgageBig: { fontFamily: FONT.display, fontSize: 48, fontWeight: '800', color: C.heroInk, lineHeight: 48, letterSpacing: -2 },
  mortgageFallback: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.heroInk2, marginTop: 14 },

  // WHIT-296: the rich payoff variant — mirrors the /mortgage hero (eyebrow, big figure, %
  // gone, bar, to-go row) but scaled to card size so it leads the list without swamping the
  // goal cards below. Column layout (the plain variant above is a row).
  mortgageCardRich: { position: 'relative', overflow: 'hidden', backgroundColor: C.accent, borderRadius: 20, padding: 18, marginBottom: 20 },
  mortgageRichHead: { flexDirection: 'row', alignItems: 'center', gap: 13 },

  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textDim, letterSpacing: 0.5, marginBottom: 12, marginLeft: 2 },

  goalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 12 },

  // WHIT-295: the additive invite shown when the mortgage is your only goal — a light hint line,
  // not a "you have nothing" card, since the mortgage above already counts.
  emptyHint: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, lineHeight: 19, textAlign: 'center', marginTop: 2, marginBottom: 14, paddingHorizontal: 10 },

  addGoal: { marginTop: 8, marginBottom: 6, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: tint(C.accentAlt, 0.4), backgroundColor: tint(C.accentAlt, 0.07), borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addGoalText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 16 },
  errorText: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, textAlign: 'center' },
});
