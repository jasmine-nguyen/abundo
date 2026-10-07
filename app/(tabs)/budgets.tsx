import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmtExact, fmtSignedExact, tint, PRESSED } from '../../src/theme';
import { formatDayMonth } from '../../src/dateutil';
import { Icon } from '../../src/icons';
import { budgetViews, type BudgetView } from '../../src/context';
import { useBudgetsScreenData } from '../../src/queries';
import { urgentFirst } from '../../src/budgetOrder';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { BudgetBar, RetryButton, HeroGradientFill, HeaderIconButton } from '../../src/components/ui';
import { SettingsButton } from '../../src/components/SettingsButton';
import { StaleDataLine } from '../../src/components/ListStates';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { useLargeText, LARGE_TEXT_MAX_SCALE } from '../../src/hooks/useLargeText';
import { loadFailureReason } from '../../src/apiError';

// The tick just crosses the bar; nothing sits beside it (WHIT-741, WHIT-744).
const SHORT_TICK_TAIL = 3;
// Space between the bar's bottom and a note; clears the short tick (it reaches 4pt below the bar).
const NOTE_GAP = 8;
// The tick band's height plus its 1pt top margin in BudgetBar.
const TICK_BAND = SHORT_TICK_TAIL + 1;
// Both big hero numbers grow with the user's text size up to the same cap, so they stay one size (WHIT-741).
const HERO_BIG_MAX_SCALE = 1.4;

const SECTIONS: { section: BudgetView['section']; heading: string }[] = [
  { section: 'spending', heading: 'SPENDING' },
  { section: 'earning', heading: 'EARNING' },
];

// At very large text the row stacks (name, then sub-lines, then amount) instead of squeezing,
// so no word splits mid-word (WHIT-743).
function RowHeader({ b }: { b: BudgetView }) {
  const large = useLargeText();
  const chip = <View style={[styles.chip, { backgroundColor: b.chipBg }]}><Icon name={b.icon} size={23} color={b.color} /></View>;
  const name = <Text style={styles.rowName} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{b.name}</Text>;
  const subs = <Text style={styles.rowSub} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{b.spentLabel}</Text>;
  const remain = (
    <>
      <Text style={[styles.rowRemain, { color: b.remainColor }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{b.remainAmount}</Text>
      <Text style={styles.rowRemainLabel} numberOfLines={1} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{b.remainLabel}</Text>
    </>
  );
  if (large) {
    return (
      <View>
        <View style={styles.rowNameLine}>
          {chip}
          <View style={{ flex: 1, minWidth: 0 }}>{name}</View>
        </View>
        <View style={styles.rowStackBody}>
          {subs}
          <View style={styles.rowStackRemain}>{remain}</View>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 13 }}>
      {chip}
      <View style={{ flex: 1, minWidth: 0 }}>
        {name}
        {subs}
      </View>
      <View style={styles.rowRight}>{remain}</View>
    </View>
  );
}

function BudgetRow({ b }: { b: BudgetView }) {
  const router = useRouter();
  const note = b.note ? <Text testID={`budget-row-note-${b.id}`} style={styles.note} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{b.note}</Text> : null;
  return (
    <Pressable testID={`budget-row-${b.id}`} onPress={() => router.push(`/budget/${b.id}`)} style={({ pressed }) => [styles.row,b.depth > 0 && { marginLeft: b.depth * 18, borderLeftWidth: 2, borderLeftColor: b.color }, pressed && PRESSED]}>
      <RowHeader b={b} />
      {/* WHIT-730: nothing spent yet → a slim row with no bar or pace line, so active budgets stand out. */}
      {b.unspent ? (
        note && <View style={styles.slimNote}>{note}</View>
      ) : (
        <View style={{ marginTop: 15 }}>
          <BudgetBar postedPct={b.postedPct} pendingPct={b.pendingPct} targetPct={b.targetPct} postedColor={b.postedColor} pendingTint={b.pendingTint} showTarget={b.showTarget} tickTail={SHORT_TICK_TAIL} />
          {note && <View style={[styles.noteUnderBar, b.showTarget && styles.noteUnderTick]}>{note}</View>}
        </View>
      )}
    </Pressable>
  );
}

function BudgetsHero({ daysLeft, nextPayday, money, totals, children }: { daysLeft: number; nextPayday: string; money?: { amount: string; label: string }; totals?: { spent: string; budget: string }; children?: React.ReactNode }) {
  const stats: { label: string; value: string; testID: string }[] = [];
  if (totals) {
    stats.push({ label: 'Spent', value: totals.spent, testID: 'budgets-hero-spent' });
    stats.push({ label: 'Budget', value: totals.budget, testID: 'budgets-hero-budget' });
  }
  if (nextPayday) stats.push({ label: 'Next payday', value: formatDayMonth(nextPayday), testID: 'budgets-hero-payday' });
  // At very large text the two big numbers and the stats stack, so neither number is squeezed (WHIT-743).
  const large = useLargeText();
  // Side by side each stat takes a third of the width; stacked it takes the full width.
  const statWidth = large ? undefined : styles.heroStat;
  const statLabel = (stat: typeof stats[number]) => <Text style={[statWidth, styles.heroSmall]}>{stat.label}</Text>;
  const statValue = (stat: typeof stats[number]) => (
    <Text testID={stat.testID} style={[statWidth, styles.heroStatValue]} numberOfLines={1} adjustsFontSizeToFit>{stat.value}</Text>
  );
  return (
    <View style={styles.hero}>
      <HeroGradientFill />
      <View style={styles.heroBlob1} />
      <View style={styles.heroBlob2} />
      <Text style={styles.heroEyebrow}>THIS PAY CYCLE</Text>
      <View style={large ? styles.heroTopStack : styles.heroTop}>
        <View style={large ? undefined : styles.heroDaysCol}>
          <Text style={styles.heroBig} numberOfLines={1} maxFontSizeMultiplier={HERO_BIG_MAX_SCALE}>{daysLeft}</Text>
          <Text style={styles.heroLabel}>{daysLeft === 1 ? 'day left' : 'days left'}</Text>
        </View>
        {money ? (
          <View style={large ? undefined : styles.heroMoneyCol}>
            <Text style={styles.heroBig} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={HERO_BIG_MAX_SCALE}>{money.amount}</Text>
            <Text style={styles.heroLabel}>{money.label}</Text>
          </View>
        ) : null}
      </View>
      {stats.length > 0 && large ? (
        <View style={[styles.heroStats, styles.heroStatsStack]}>
          {stats.map((stat) => <View key={stat.testID}>{statLabel(stat)}{statValue(stat)}</View>)}
        </View>
      ) : null}
      {stats.length > 0 && !large ? (
        <View style={styles.heroStats}>
          <View style={styles.heroStatsRow}>{stats.map((stat) => <React.Fragment key={stat.testID}>{statLabel(stat)}</React.Fragment>)}</View>
          <View style={styles.heroStatsRow}>{stats.map((stat) => <React.Fragment key={stat.testID}>{statValue(stat)}</React.Fragment>)}</View>
        </View>
      ) : null}
      {children}
    </View>
  );
}

export default function Budgets() {
  const router = useRouter();
  // WHIT-188: data now comes from the cached, auth-gated, self-healing query layer
  // instead of the eager global store. A transient 5xx retries with backoff (no stuck
  // banner); the inline error/retry below is the local fallback for a sustained failure.
  const {
    budgets, category, cycleLen, daysLeft, nextPayday, isLoading, isError, payCycleError, payCycleReady, error, refreshError, updatedAt, refetch, refetchStale,
  } = useBudgetsScreenData();

  // Load-on-focus: refresh when the tab regains focus, but only if the data has gone
  // stale (the window rolls over on payday; a save/categorise elsewhere moves numbers).
  // Staleness-gated so hopping between tabs doesn't refetch on every tap.
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  const view = budgetViews({ budgets, category, cycleLen, daysLeft, nextPayday });
  const { totBudget, totSpent, totRemain } = view;
  const rows = urgentFirst(view.rows);

  // Over from a cent over, matching the rows (WHIT-716); the tiny threshold only absorbs float dust so "−$0" never shows.
  const overBudget = totRemain < -0.005;
  const noRows = rows.length === 0;
  // WHIT-714: income rows and Savings budgets never feed the totals, so the money side only
  // means something when there's at least one spending row.
  const hasSpending = rows.some((b) => b.section === 'spending');

  // Cache-first: once we have any rows, keep showing them while a background refetch
  // runs. Error takes precedence over the spinner — a failed read must never sit under an
  // endless spinner with no Retry (code-critic/qa #1). WHIT-72: also error out when the pay
  // cycle failed to load at all (payCycleError) — budgets now fetch in parallel, so without
  // this the rows would render against the DEFAULT cycle (a wrong days-left + pace bars).
  const showError = (isError && rows.length === 0) || payCycleError;
  const showSpinner = !showError && isLoading && rows.length === 0;
  // WHIT-713: a pull refreshes the pay cycle, budgets and categories (no live balances here).
  const { pulling, onRefresh } = usePullToRefresh(refetch);

  // Scroll-to-hide chrome + the floating header now live in the shared ScrollChromeHeader
  // wrapper (WHIT-199). The spinner/error states render as centered children (flexGrow so
  // they sit mid-viewport under the floating header); the loaded content scrolls normally.
  return (
    <ScrollChromeHeader
      title="Budgets"
      left={<SettingsButton />}
      right={<HeaderIconButton icon="plus" accessibilityLabel="Add budget" onPress={() => router.push('/budget/pick')} />}
      // Always fill the viewport, so a short budget list is still a pull-to-refresh target.
      contentContainerStyle={styles.fill}
      refreshing={pulling && !showSpinner}
      onRefresh={onRefresh}
    >
      {showSpinner ? (
        <>
          {payCycleReady ? <BudgetsHero daysLeft={daysLeft} nextPayday={nextPayday} /> : null}
          <View testID="budgets-loading" style={styles.centered}>
            <ActivityIndicator color={C.accent} />
          </View>
        </>
      ) : showError ? (
        <View testID="budgets-error" style={styles.centered}>
          <Text style={styles.errorText}>Couldn't load your budgets.</Text>
          <Text style={styles.errorText}>{loadFailureReason(error)}</Text>
          <RetryButton onPress={refetch} label="Retry loading your budgets" testID="budgets-retry" />
        </View>
      ) : (
      <>
        <BudgetsHero
          daysLeft={daysLeft}
          nextPayday={nextPayday}
          money={hasSpending ? {
            amount: fmtSignedExact(totRemain),
            label: overBudget ? 'Over budget' : 'Left to spend',
          } : undefined}
          totals={hasSpending ? { spent: fmtExact(totSpent), budget: fmtSignedExact(totBudget) } : undefined}
        >
          {hasSpending ? null : (
            <View style={styles.heroBottom}>
              <Text style={styles.heroEmpty}>No spending budgets yet. Set one and this shows what's left to spend.</Text>
              {noRows ? (
                <Pressable testID="budgets-hero-add" onPress={() => router.push('/budget/pick')} style={styles.heroAdd}>
                  <Text style={styles.heroAddText}>Add a spending budget</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </BudgetsHero>

        <StaleDataLine idPrefix="budgets" error={refreshError} updatedAt={updatedAt} />

        {SECTIONS.map(({ section, heading }) => {
          const sectionRows = rows.filter((b) => b.section === section);
          if (sectionRows.length === 0) return null;
          return (
            <React.Fragment key={section}>
              <Text style={styles.sectionLabel}>{heading}</Text>
              {sectionRows.map((b) => <BudgetRow key={b.id} b={b} />)}
            </React.Fragment>
          );
        })}
      </>
      )}
    </ScrollChromeHeader>
  );
}

const styles = StyleSheet.create({
  // Grows the ScrollView content so the spinner/error state centres mid-viewport (WHIT-199).
  fill: { flexGrow: 1 },

  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 24, paddingTop: 26, paddingBottom: 22, marginBottom: 22, backgroundColor: C.accent },
  heroBlob1: { position: 'absolute', right: -30, top: -30, width: 150, height: 150, borderRadius: 75, backgroundColor: C.heroBlobFill },
  heroBlob2: { position: 'absolute', right: 34, bottom: -46, width: 90, height: 90, borderRadius: 45, backgroundColor: C.heroBlobFill },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.heroInkSoft, letterSpacing: 0.2 },
  // The days column sizes to its number and the money column takes the rest, so neither number
  // shrinks alone (WHIT-741). Same size + top alignment keeps their baselines level.
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginTop: 6 },
  heroTopStack: { gap: 10, marginTop: 6 },
  heroDaysCol: { flexShrink: 0 },
  heroMoneyCol: { flex: 1, minWidth: 0 },
  // Days left and the money number share one size. No fixed lineHeight, so the number scales with the user's text size instead of clipping.
  heroBig: { fontFamily: FONT.display, fontSize: 44, fontWeight: '800', color: C.heroInk, letterSpacing: -1.5 },
  heroLabel: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.heroInk2 },
  // Labels in one row, values in the next, so a wrapped label never pushes its value out of line (WHIT-741).
  heroStats: { marginTop: 18 },
  heroStatsRow: { flexDirection: 'row', gap: 12 },
  heroStatsStack: { gap: 10 },
  heroStat: { flex: 1, minWidth: 0 },
  heroStatValue: { fontFamily: FONT.display, fontSize: 17, fontWeight: '700', color: C.heroInk, marginTop: 2 },
  heroBottom: { marginTop: 16 },
  heroSmall: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.heroInkSoft },
  heroEmpty: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.heroInk2 },
  heroAdd: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: tint(C.heroInk, 0.12), borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  heroAddText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.heroInk },

  // Same uppercase muted label as the budget detail screen's section headings.
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 4 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14, marginBottom: 12 },
  slimNote: { marginTop: 6 },
  // Caps the amount column so a big number shrinks instead of squeezing the name (large text).
  rowRight: { alignItems: 'flex-end', maxWidth: '45%' },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  rowStackBody: { marginTop: 6 },
  rowStackRemain: { marginTop: 6 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowRemain: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  rowRemainLabel: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, fontWeight: '500', marginTop: 1 },
  noteUnderBar: { marginTop: NOTE_GAP },
  noteUnderTick: { marginTop: NOTE_GAP - TICK_BAND },
  note: { fontFamily: FONT.body, fontSize: 12, color: C.textMid },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 16 },
  errorText: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, textAlign: 'center' },
});
