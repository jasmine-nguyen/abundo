import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmt, tint } from '../../src/theme';
import { formatDayMonth } from '../../src/dateutil';
import { Icon, Glyph } from '../../src/icons';
import { budgetViews, type BudgetView } from '../../src/context';
import { useBudgetsScreenData } from '../../src/queries';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { BudgetBar, RetryButton, HeroGradientFill, HeaderIconButton } from '../../src/components/ui';
import { SettingsButton } from '../../src/components/SettingsButton';

function resetsLabel(daysLeft: number): string {
  if (daysLeft === 0) return 'resets today';
  if (daysLeft === 1) return 'resets in 1 day';
  return `resets in ${daysLeft} days`;
}

const SECTIONS: { section: BudgetView['section']; heading: string }[] = [
  { section: 'spending', heading: 'SPENDING' },
  { section: 'earning', heading: 'EARNING' },
];

function BudgetRow({ b }: { b: BudgetView }) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push(`/budget/${b.id}`)} style={[styles.row, b.depth > 0 && { marginLeft: b.depth * 18, borderLeftWidth: 2, borderLeftColor: b.color }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 13 }}>
        <View style={[styles.chip, { backgroundColor: b.chipBg }]}><Icon name={b.icon} size={23} color={b.color} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowName}>{b.name}</Text>
          <Text style={styles.rowSub}>{b.spentLabel}</Text>
          {b.carryoverLabel ? <Text style={styles.rowRollover}>{b.carryoverLabel}</Text> : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.rowRemain, { color: b.remainColor }]}>{b.remainAmount}</Text>
          <Text style={styles.rowRemainLabel}>{b.remainLabel}</Text>
        </View>
      </View>
      <View style={{ marginTop: 15 }}>
        <BudgetBar postedPct={b.postedPct} pendingPct={b.pendingPct} targetPct={b.targetPct} postedColor={b.postedColor} pendingTint={b.pendingTint} showTarget={b.showTarget} />
        {b.paceLabel ? (
          <View style={styles.paceRow}>
            {b.spreadPrefill !== null ? (
              <Pressable testID={`budget-row-spread-${b.id}`} onPress={() => router.push(`/budget/spread?categoryId=${b.id}&prefill=${b.spreadPrefill}`)} hitSlop={8}>
                <Text style={[styles.paceLabel, { color: b.paceColor }]}>{b.paceLabel}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.paceLabel, { color: b.paceColor }]}>{b.paceLabel}</Text>
            )}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function BudgetsHero({ daysLeft, nextPayday, money, children }: { daysLeft: number; nextPayday: string; money?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <View style={styles.hero}>
      <HeroGradientFill />
      <View style={styles.heroBlob1} />
      <View style={styles.heroBlob2} />
      <Text style={styles.heroEyebrow}>THIS PAY CYCLE</Text>
      <View style={styles.heroTop}>
        <View style={styles.heroCol}>
          <Text style={styles.heroBig} numberOfLines={1} adjustsFontSizeToFit>{daysLeft}</Text>
          <Text style={styles.heroLabel}>{daysLeft === 1 ? 'day left' : 'days left'}</Text>
        </View>
        {money}
      </View>
      {nextPayday ? <Text style={[styles.heroSmall, styles.heroPayday]}>Next payday {formatDayMonth(nextPayday)}</Text> : null}
      {children}
    </View>
  );
}

export default function Budgets() {
  const router = useRouter();
  // WHIT-188: data now comes from the cached, auth-gated, self-healing query layer
  // instead of the eager global store. A transient 5xx retries with backoff (no stuck
  // banner); the inline error/retry below is the local fallback for a sustained failure.
  const { budgets, category, cycleLen, daysLeft, nextPayday, isLoading, isError, payCycleError, payCycleReady, refetch, refetchStale } = useBudgetsScreenData();

  // Load-on-focus: refresh when the tab regains focus, but only if the data has gone
  // stale (the window rolls over on payday; a save/categorise elsewhere moves numbers).
  // Staleness-gated so hopping between tabs doesn't refetch on every tap.
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  const { rows, totBudget, totSpent, totRemain } = budgetViews({ budgets, category, cycleLen, daysLeft, nextPayday });

  // WHIT-573: when spend has blown past the plan, totRemain is negative and the hero must read
  // "Over budget", not "Budget remaining" — fmt() strips the sign, so a bare negative total would
  // otherwise look like money still left. The -0.5 dust threshold mirrors the per-row/carryover
  // rounding (context.tsx) so a sub-dollar residual, which fmt rounds to $0, doesn't flip the headline.
  const overBudget = totRemain < -0.5;
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

  // Scroll-to-hide chrome + the floating header now live in the shared ScrollChromeHeader
  // wrapper (WHIT-199). The spinner/error states render as centered children (flexGrow so
  // they sit mid-viewport under the floating header); the loaded content scrolls normally.
  return (
    <ScrollChromeHeader
      title="Budgets"
      left={<SettingsButton />}
      right={<HeaderIconButton icon="plus" accessibilityLabel="Add budget" onPress={() => router.push('/budget/pick')} />}
      contentContainerStyle={(showSpinner || showError) ? styles.fill : undefined}
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
          <RetryButton onPress={refetch} label="Retry loading your budgets" testID="budgets-retry" style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      ) : (
      <>
        <BudgetsHero
          daysLeft={daysLeft}
          nextPayday={nextPayday}
          money={hasSpending ? (
            <View style={styles.heroCol}>
              <Text style={styles.heroBig} numberOfLines={1} adjustsFontSizeToFit>{overBudget ? `−${fmt(totRemain)}` : fmt(totRemain)}</Text>
              <Text style={styles.heroLabel}>{overBudget ? 'Over budget' : 'Left to spend'}</Text>
            </View>
          ) : null}
        >
          {hasSpending ? (
            <View style={[styles.heroBottom, styles.heroBottomRow]}>
              <View style={styles.heroPill}>
                <Text style={styles.heroPillTop}>of {fmt(totBudget)}</Text>
                <Text style={styles.heroPillBot}>{fmt(totSpent)} spent</Text>
              </View>
              {overBudget ? <Text style={styles.heroOver}>{`Over by ${fmt(totRemain)} · ${resetsLabel(daysLeft)}`}</Text> : null}
            </View>
          ) : (
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

        {noRows ? null : <Text style={styles.caption}>Solid = spent · faded = pending · line = today's pace</Text>}

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

        {noRows ? null : (
          <Pressable onPress={() => router.push('/budget/pick')} style={styles.addBudget}>
            <Glyph name="plus" size={18} color={C.accentSoft} />
            <Text style={styles.addBudgetText}>Add a budget</Text>
          </Pressable>
        )}
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
  heroTop: { flexDirection: 'row', gap: 16, marginTop: 6 },
  // Columns share the row equally; minWidth 0 lets adjustsFontSizeToFit shrink a long amount.
  heroCol: { flex: 1, minWidth: 0 },
  // One style for both big numbers (days left + money left) so they read at equal weight. No fixed
  // lineHeight, so the number scales with the user's text size instead of clipping.
  heroBig: { fontFamily: FONT.display, fontSize: 44, fontWeight: '800', color: C.heroInk, letterSpacing: -1.5 },
  heroLabel: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.heroInk2 },
  heroPayday: { marginTop: 10 },
  heroBottom: { marginTop: 16 },
  heroBottomRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroSmall: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.heroInkSoft },
  heroPill: { backgroundColor: tint(C.heroInk, 0.12), borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 },
  heroPillTop: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', color: C.heroInkSoft },
  heroPillBot: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.heroInk, marginTop: 2 },
  heroOver: { flex: 1, minWidth: 0, fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.heroInk },
  heroEmpty: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.heroInk2 },
  heroAdd: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: tint(C.heroInk, 0.12), borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  heroAddText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.heroInk },

  caption: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, fontWeight: '500', marginHorizontal: 4 },
  // Same uppercase muted label as the budget detail screen's section headings.
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 4 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, paddingBottom: 14, marginBottom: 12 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowRollover: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', color: C.textInfo, marginTop: 3 },
  rowRemain: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  rowRemainLabel: { fontFamily: FONT.body, fontSize: 11, color: C.textDim, fontWeight: '500', marginTop: 1 },
  // WHIT-281: the "today's pace" tick is labelled once in the caption up top; a per-row
  // "target" caption here was redundant AND overlapped the right-aligned pace status when
  // the tick sat far right. Removed — only the pace status remains, right-aligned.
  paceRow: { minHeight: 18, marginTop: 1, alignItems: 'flex-end', justifyContent: 'center' },
  paceLabel: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '700' },

  addBudget: { marginTop: 8, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: tint(C.accentAlt, 0.4), backgroundColor: tint(C.accentAlt, 0.07), borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addBudgetText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 16 },
  errorText: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 11, paddingHorizontal: 24, borderRadius: 12, backgroundColor: tint(C.accentAlt, 0.16) },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
