import { Fragment, useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, fmt, tint, breakdownLineStyle } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { useLargeText, LARGE_TEXT_MAX_SCALE, HERO_BIG_MAX_SCALE } from '../../src/hooks/useLargeText';
import { StackingRowHeader, rowTextStyles } from '../../src/components/StackingRowHeader';
import { categoryBreakdown, incomeBreakdown } from '../../src/context';
import { useAiInsights } from '../../src/hooks/useAiInsights';
import { useInsightsScreenData, usePayCycle } from '../../src/queries';
import { dayOfCycle } from '../../src/payCycle';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { ReadableColumn } from '../../src/components/ReadableColumn';
import { HeroGradientFill, HeroBlobs, SectionLabel } from '../../src/components/ui';
import { ListStates, StaleDataLine } from '../../src/components/ListStates';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { ExportButton } from '../../src/components/ExportButton';
import { AiCoachCard } from '../../src/components/AiCoachCard';
import { SpendingDonut } from '../../src/components/SpendingDonut';
import { EarnedVsSpent } from '../../src/components/EarnedVsSpent';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { toggleIn, visibleTreeRows } from '../../src/setutil';
import { bucketSections } from '../../src/breakdownSections';

// One header for every Insights row (spending, refund/"Other", earning); stacks at large text (ABU-63).
function RowHeader({ row, nameColor = C.textBright, sub, amount, amountColor = C.textBright, chevron }: {
  row: { icon: string; color: string; chipBg: string; name: string };
  nameColor?: string; sub?: string; amount: string; amountColor?: string; chevron?: string;
}) {
  const large = useLargeText();
  const amountText = (
    <Text style={[styles.rowAmount, { color: amountColor }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{amount}</Text>
  );
  return (
    <StackingRowHeader
      icon={row.icon} color={row.color} chipBg={row.chipBg}
      name={<Text style={[rowTextStyles.name, { color: nameColor }]} numberOfLines={large ? 2 : 1} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{row.name}</Text>}
      sub={sub ? <Text style={rowTextStyles.sub} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{sub}</Text> : undefined}
      right={chevron ? (
        <View style={styles.amountWithChevron}>
          <Glyph name={chevron} size={18} color={C.textDim} />
          {amountText}
        </View>
      ) : amountText}
    />
  );
}

export default function Insights() {
  const { refresh: refreshAiInsights } = useAiInsights();
  const router = useRouter();
  // WHIT-68: which pay cycle the hero + category rows show — 0 = this (current, partial)
  // cycle, 1 = last (full) cycle. Only the breakdown reads move; the AI coach stays current.
  const [cycle, setCycle] = useState(0);
  // WHIT-189: breakdown now comes from the cached, auth-gated, self-healing query layer.
  // `incomeSources = []` default: the real hook always returns an array, but the default keeps a
  // hand-mocked test harness that omits it from throwing on `.length` (WHIT-381).
  const {
    breakdown, earned, incomeSources = [], category, isLoading, isError, categoriesError,
    error, refreshError, updatedAt, refetch, refetchStale,
  } = useInsightsScreenData(cycle);
  // ABU-62: the hero's "day 6 of 14". Read apart from the Insights data so a pay-cycle failure
  // never blanks the spending (WHIT-840); the day only shows once the real cycle has loaded.
  const { cycleLen, daysLeft, payCycleReady } = usePayCycle();
  const { pulling, onRefresh } = usePullToRefresh(refetch);
  const { rows, total } = categoryBreakdown({ breakdown, category });

  // WHIT-373: one list, a switch. "Spending" shows the category breakdown; "Earning" shows the same
  // cycle's income sources. Default is Spending. `side` is clamped to 'spending' whenever the toggle
  // is hidden (nothing to switch to), so an income-only cycle a user last left on Earning can't come
  // back to a blank hidden-toggle screen.
  const { rows: incomeRows } = incomeBreakdown({ incomeSources, earned, category });
  // Each source's share of total income drives its green bar. Denominator is the shown positive
  // income (a reversed source or the muted plug adds no bar), so the bars read as a share of income.
  const incomeShareTotal = incomeRows.reduce((sum, r) => (r.muted || r.amount < 0 ? sum : sum + r.amount), 0);
  const [sideChoice, setSideChoice] = useState<'spending' | 'earning'>('spending');

  // WHIT-226: parent categories are collapsed by default; tap to reveal their subs. A row
  // shows only when its whole parent chain is expanded (rows come depth-first, so a parent
  // is seen before its children). Replace the Set on toggle so the screen redraws.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setExpanded((prev) => toggleIn(prev, id)), []);
  const visibleRows = visibleTreeRows(rows, (r) => r.id, (id) => expanded.has(id));
  const topLevelRows = rows.filter((r) => r.depth === 0 && !r.isRefund);  // refund lines are never top-level (WHIT-349)
  const topLevelCount = topLevelRows.length;  // hero "N categories"
  // Donut slices: one per top-level category (its combined spend), painted in its own colour
  // so the ring and the rows below read as one legend. Sums to the hero total (every txn rolls
  // up to exactly one top-level row), so each slice's share matches its row's "% of spend".
  const donutSlices = topLevelRows.map((r) => ({ id: r.id, name: r.name, color: r.color, value: r.spent }));

  // Re-pull on focus: breakdown via the query (staleness-gated), AI insights via its
  // query. Spend depends on the current cycle (rolls over on payday; categorising
  // elsewhere moves the numbers); AI is any insight already cached for this cycle.
  useFocusEffect(useCallback(() => {
    refetchStale();
    refreshAiInsights();
  }, [refetchStale, refreshAiInsights]));

  // Cache-first, error before spinner (mirrors Budgets). The hero + rows depend on
  // breakdown; the AI card does NOT, so it stays visible through a breakdown load/error.
  // WHIT-194: also error out when categories failed on first load (categoriesError) — even
  // though breakdown may still hold a taxonomy-free Uncategorized row (rows.length > 0), the
  // real-category rows all dropped, so the hero total would silently omit real spend. This is
  // the Insights-only hole Budgets doesn't have (every Budgets row needs a category).
  const showError = (isError && rows.length === 0) || categoriesError;
  const showSpinner = !showError && isLoading && rows.length === 0;

  // The Spending/Earning toggle only shows when a side has content — otherwise it's a dead switch.
  // With it hidden, `side` falls back to Spending so the "No spending" empty renders (never a blank).
  const hasSpend = rows.length > 0;
  const hasIncome = incomeRows.length > 0;
  const showToggle = !showSpinner && !showError && (hasSpend || hasIncome);
  const side = showToggle ? sideChoice : 'spending';

  let heroSub = `spent across ${topLevelCount} ${topLevelCount === 1 ? 'category' : 'categories'}`;
  if (cycle === 0 && payCycleReady) heroSub += ` · day ${dayOfCycle({ cycleLen, daysLeft })} of ${cycleLen}`;

  // ABU-68: the spending cards grouped under LIVING / LIFESTYLE / UNCATEGORISED headings.
  const sections = bucketSections(visibleRows, (r) => category(r.id)?.bucket ?? null);
  const renderSpendRow = (r: (typeof visibleRows)[number]) => {
    // WHIT-349/357: a muted display-only line under an expanded parent — no bar. A refund
    // line shows a credit in green and taps into that sub's charges. A WHIT-357 "Other" line
    // plugs the residual so the expanded rows sum to the node; it is neutral and NOT tappable
    // (it isn't a real category, so there is nothing to drill into).
    if (r.isRefund || r.isRemainder) {
      // WHIT-375: the refund/"Other" amount + colours come from the one shared convention
      // (see breakdownLineStyle) so this can't drift from the breakdown screen again.
      const { amountText, amountColor, nameColor } = breakdownLineStyle(r);
      const body = <RowHeader row={r} nameColor={nameColor} sub={r.spentLabel} amount={amountText} amountColor={amountColor} />;
      return (
        <View key={r.id} style={[styles.row, { marginLeft: r.depth * 18, borderLeftWidth: 2, borderLeftColor: r.color }]}>
          {r.isRefund ? (
            <Pressable
              onPress={() => router.push(`/category/${encodeURIComponent(r.drillId)}?cycle=${cycle}`)}
              accessibilityRole="button"
            >
              {body}
            </Pressable>
          ) : body}
        </View>
      );
    }
    // Bar width is the row's share of the cycle total; within it, split posted
    // vs pending so the pending portion reads distinctly.
    // Clamp the bar at 100% so it can never overflow its track (a corrupt parent
    // cycle can inflate pct past 100 — unreachable via the app, but cheap to guard).
    const barPct = Math.min(100, r.pct);
    const postedW = r.spent > 0 ? barPct * (r.posted / r.spent) : 0;
    const pendingW = Math.max(0, barPct - postedW);
    const open = expanded.has(r.id);
    return (
      <View key={r.id} style={[styles.row, r.depth > 0 && { marginLeft: r.depth * 18, borderLeftWidth: 2, borderLeftColor: r.color }]}>
        <Pressable
          // WHIT-308: a parent row still expands its subs; a leaf / "Directly in X" /
          // Uncategorized row drills into its transactions for the selected cycle.
          onPress={r.hasChildren ? () => toggle(r.id) : () => router.push(`/category/${encodeURIComponent(r.drillId)}?cycle=${cycle}`)}
          accessibilityRole="button"
          accessibilityState={r.hasChildren ? { expanded: open } : undefined}
        >
          <RowHeader
            row={r} sub={r.spentLabel} amount={fmt(r.spent)}
            chevron={r.hasChildren ? (open ? 'chevronDown' : 'chevron') : undefined}
          />
        </Pressable>
        <View style={styles.track}>
          <View style={{ width: `${postedW}%`, backgroundColor: r.color, height: '100%', borderRadius: 5 }} />
          {pendingW > 0 && (
            <View style={{ width: `${pendingW}%`, backgroundColor: tint(r.color, 0.45), height: '100%', borderRadius: 5 }} />
          )}
        </View>
      </View>
    );
  };

  return (
    <ReadableColumn>
      <ScrollChromeHeader
        title="Insights"
        subtitle={showSpinner || showError ? null : <StaleDataLine idPrefix="insights" error={refreshError} updatedAt={updatedAt} showUpdated />}
        right={<ExportButton cycle={cycle} category={category} />}
        refreshing={pulling && !showSpinner}
        onRefresh={onRefresh}
      >
        {/* WHIT-68: look back one pay cycle. "This cycle" is spend so far; "Last cycle"
            is the full prior cycle. Switching only moves the hero + rows (the AI coach
            below stays about the current cycle). */}
        <SegmentedControl
          value={cycle}
          onChange={setCycle}
          options={[
            { value: 0, label: 'This cycle', testID: 'insights-cycle-current', activeTint: tint(C.accentAlt, 0.16), activeTextColor: C.accentSoft },
            { value: 1, label: 'Last cycle', testID: 'insights-cycle-prev', activeTint: tint(C.accentAlt, 0.16), activeTextColor: C.accentSoft },
          ]}
        />

        {/* hero: where the money went in the selected cycle */}
        <View style={styles.hero}>
          <HeroGradientFill />
          <HeroBlobs />
          <Text style={styles.heroEyebrow} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{cycle === 0 ? 'THIS PAY CYCLE' : 'LAST PAY CYCLE'}</Text>
          {/* Never show a confident "$0" over a load/error — the total reads breakdown,
              which isn't ready yet. A legit zero-spend cycle (loaded, no rows) still
              shows $0. WHIT-189. */}
          {showSpinner || showError ? (
            <>
              <Text style={styles.heroTotal} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={HERO_BIG_MAX_SCALE}>—</Text>
              <Text style={styles.heroSub} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{showError ? "Couldn't load" : 'Loading…'}</Text>
            </>
          ) : (
            <>
              <Text testID="insights-hero-total" style={styles.heroTotal} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={HERO_BIG_MAX_SCALE}>{fmt(total)}</Text>
              <Text testID="insights-hero-sub" style={styles.heroSub} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{heroSub}</Text>
            </>
          )}
        </View>

        {/* AI "coach" card (WHIT-104). WHIT-68: it's a CURRENT-cycle tool, so it's hidden
            while viewing a past cycle rather than showing advice that contradicts the
            "LAST PAY CYCLE" hero. Self-contained (reads the AI slice + goal itself). */}
        {cycle === 0 && <AiCoachCard />}

        <ListStates
          showSpinner={showSpinner} showError={showError} error={error} idPrefix="insights"
          errorText="Couldn't load your spending." retryLabel="Retry loading your insights" onRetry={refetch}
        />
        {/* Pie/donut of where the cycle's money went — one wedge per top-level category, in
            its own colour, sized by share of the total. The rows below are its legend. */}
        {!showSpinner && !showError && rows.length > 0 && (
          <SpendingDonut slices={donutSlices} testID="insights-donut" />
        )}

        {/* WHIT-312: earned vs spent for the cycle — a pure summary card (WHIT-373 removed the
            per-bar drill; the Spending/Earning toggle below is the one, consistent way to drill in).
            Shows whenever there's income OR spend, so an income-only cycle still gets the comparison.
            WHIT-324: surplus vs deficit only (no budget), so it hides when there was neither. */}
        {!showSpinner && !showError && (earned > 0 || rows.length > 0) && (
          <EarnedVsSpent earned={earned} spent={total} cycle={cycle} testID="insights-earned-spent" />
        )}

        {/* WHIT-373: one list, a switch — Spending shows the category breakdown, Earning shows the
            same cycle's income sources. Only shown when a side has content (else it's a dead switch). */}
        {showToggle && (
          <SegmentedControl
            value={side}
            onChange={setSideChoice}
            options={[
              { value: 'spending', label: 'Spending', testID: 'insights-side-spending', activeTint: tint(C.accentAlt, 0.16), activeTextColor: C.accentSoft },
              { value: 'earning', label: 'Earning', testID: 'insights-side-earning', activeTint: tint(C.good, 0.16), activeTextColor: C.good },
            ]}
          />
        )}

        {!showSpinner && !showError && side === 'spending' && rows.length === 0 && (
          <Text style={styles.empty} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>
            {cycle === 0 ? 'No spending yet this pay cycle.' : 'No spending in that pay cycle.'}
          </Text>
        )}

        {/* WHIT-194: suppress the row list under an error — otherwise the surviving
            taxonomy-free Uncategorized row would render beneath the "Couldn't load" card. */}
        {!showError && side === 'spending' && sections.map((s) => (
          <Fragment key={s.key}>
            <SectionLabel testID={`insights-section-${s.key}`} style={{ marginTop: 18 }}>{s.heading}</SectionLabel>
            {s.rows.map(renderSpendRow)}
          </Fragment>
        ))}

        {/* Earning side: one row per income source, biggest first, each with a green bar for its
            share of total income. WHIT-373 folds in the retired /breakdown earned view. */}
        {!showSpinner && !showError && side === 'earning' && incomeRows.length > 0 && (
          <Text testID="insights-income-caption" style={styles.barsCaption} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>
            Each bar shows the source's share of total income.
          </Text>
        )}
        {!showSpinner && !showError && side === 'earning' && incomeRows.length === 0 && (
          <Text style={styles.empty} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>
            {cycle === 0 ? 'No income yet this pay cycle.' : 'No income in that pay cycle.'}
          </Text>
        )}
        {!showSpinner && !showError && side === 'earning' && incomeRows.map((r) => {
          // WHIT-375/376: amount text + colours come from the one shared convention (see
          // breakdownLineStyle) — the same rule the spending rows use. A muted plug isn't a real
          // source: it's dimmed, gets no bar, and doesn't drill.
          const { amountText, amountColor, nameColor } = breakdownLineStyle({ isReversed: r.reversed, isRemainder: r.muted, spent: r.amount });
          const barPct = incomeShareTotal > 0 && !r.muted && r.amount > 0 ? Math.min(100, (r.amount / incomeShareTotal) * 100) : 0;
          // Each source's bar is its own chart-palette colour, so the Earning list matches the pie
          // and the spending rows (one colour per source), not a single flat green (WHIT chart palette).
          const body = (
            <RowHeader
              row={r} nameColor={nameColor} amount={amountText} amountColor={amountColor}
              sub={r.pending > 0 ? `${fmt(r.pending)} pending` : undefined}
            />
          );
          return (
            <View key={r.id} style={styles.row}>
              {r.muted ? body : (
                <Pressable
                  onPress={() => router.push(`/category/${encodeURIComponent(r.drillId)}?cycle=${cycle}`)}
                  accessibilityRole="button"
                >
                  {body}
                </Pressable>
              )}
              {barPct > 0 && (
                <View style={styles.track}>
                  <View style={{ width: `${barPct}%`, backgroundColor: r.color, height: '100%', borderRadius: 5 }} />
                </View>
              )}
            </View>
          );
        })}
      </ScrollChromeHeader>
    </ReadableColumn>
  );
}

const styles = StyleSheet.create({
  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 24, paddingTop: 26, paddingBottom: 22, marginBottom: 22, backgroundColor: C.accent },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.heroInkSoft, letterSpacing: 0.2 },
  heroTotal: { fontFamily: FONT.display, fontSize: 44, fontWeight: '800', color: C.heroInk, letterSpacing: -1.5, marginTop: 4 },
  heroSub: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.heroInk2, marginTop: 2 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, paddingBottom: 14, marginBottom: 12 },
  rowAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', letterSpacing: -0.4 },
  amountWithChevron: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  track: { flexDirection: 'row', gap: 2, height: 8, marginTop: 14, backgroundColor: C.progressTrack, borderRadius: 5, overflow: 'hidden' },

  barsCaption: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, textAlign: 'center', marginTop: -6, marginBottom: 16 },
  empty: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, textAlign: 'center', paddingVertical: 40 },
});
