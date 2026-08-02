import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, fmt, tint, breakdownLineStyle } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, categoryBreakdown, incomeBreakdown } from '../../src/context';
import { useInsightsScreenData } from '../../src/queries';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { RetryButton, HeroGradientFill } from '../../src/components/ui';
import { AiCoachCard } from '../../src/components/AiCoachCard';
import { SpendingDonut } from '../../src/components/SpendingDonut';
import { EarnedVsSpent } from '../../src/components/EarnedVsSpent';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { chartCategoryColor } from '../../src/theme/chartColors';

export default function Insights() {
  const s = useAppContext(); // the AI-insights slice (aiInsights / generate / refresh) stays on the store
  const router = useRouter();
  // WHIT-68: which pay cycle the hero + category rows show — 0 = this (current, partial)
  // cycle, 1 = last (full) cycle. Only the breakdown reads move; the AI coach stays current.
  const [cycle, setCycle] = useState(0);
  // WHIT-189: breakdown now comes from the cached, auth-gated, self-healing query layer.
  // `incomeSources = []` default: the real hook always returns an array, but the default keeps a
  // hand-mocked test harness that omits it from throwing on `.length` (WHIT-381).
  const { breakdown, earned, incomeSources = [], category, isLoading, isError, categoriesError, refetch, refetchStale } = useInsightsScreenData(cycle);
  // Recolour the Insights pie + rows from the chart palette: wrap the category accessor so its
  // `color` comes from the category's PERMANENT server-assigned slot (falling back to the id-derived
  // colour when a category has no slot yet), then feed that to the breakdown selectors. The pie
  // slices, row icons, chips, and bars all read the wrapped colour — so this screen recolours
  // consistently while Budgets / Transactions keep the app-wide `colorForCategory` untouched.
  const chartCategory = useCallback((id: string) => {
    const c = category(id);
    if (!c) return c;
    return { ...c, color: chartCategoryColor(id, { slot: c.colorSlot }) };
  }, [category]);
  const { rows, total } = categoryBreakdown({ breakdown, category: chartCategory });

  // WHIT-373: one list, a switch. "Spending" shows the category breakdown; "Earning" shows the same
  // cycle's income sources. Default is Spending. `side` is clamped to 'spending' whenever the toggle
  // is hidden (nothing to switch to), so an income-only cycle a user last left on Earning can't come
  // back to a blank hidden-toggle screen.
  const { rows: incomeRows } = incomeBreakdown({ incomeSources, earned, category: chartCategory });
  // Each source's share of total income drives its green bar. Denominator is the shown positive
  // income (a reversed source or the muted plug adds no bar), so the bars read as a share of income.
  const incomeShareTotal = incomeRows.reduce((sum, r) => (r.muted || r.amount < 0 ? sum : sum + r.amount), 0);
  const [sideChoice, setSideChoice] = useState<'spending' | 'earning'>('spending');

  // WHIT-226: parent categories are collapsed by default; tap to reveal their subs. A row
  // shows only when its whole parent chain is expanded (rows come depth-first, so a parent
  // is seen before its children). Replace the Set on toggle so the screen redraws.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const shown = new Set<string>();
  for (const r of rows) {
    if (r.parentId === null || (shown.has(r.parentId) && expanded.has(r.parentId))) shown.add(r.id);
  }
  const visibleRows = rows.filter((r) => shown.has(r.id));
  const topLevelRows = rows.filter((r) => r.depth === 0 && !r.isRefund);  // refund lines are never top-level (WHIT-349)
  const topLevelCount = topLevelRows.length;  // hero "N categories"
  // Donut slices: one per top-level category (its combined spend), painted in its own colour
  // so the ring and the rows below read as one legend. Sums to the hero total (every txn rolls
  // up to exactly one top-level row), so the total sits in the centre.
  const donutSlices = topLevelRows.map((r) => ({ id: r.id, name: r.name, color: r.color, value: r.spent }));

  // Re-pull on focus: breakdown via the query (staleness-gated), AI insights via the
  // store. Spend depends on the current cycle (rolls over on payday; categorising
  // elsewhere moves the numbers); AI is any insight already cached for this cycle.
  useFocusEffect(useCallback(() => {
    refetchStale();
    s.refreshAiInsights();
  }, [refetchStale, s.refreshAiInsights]));

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

  return (
    <ScrollChromeHeader title="Insights">
        {/* WHIT-68: look back one pay cycle. "This cycle" is spend so far; "Last cycle"
            is the full prior cycle. Switching only moves the hero + rows (the AI coach
            below stays about the current cycle). */}
        <SegmentedControl
          value={cycle}
          onChange={setCycle}
          options={[
            { value: 0, label: 'This cycle', testID: 'insights-cycle-current', activeTint: 'rgba(124,140,255,.16)', activeTextColor: C.accentSoft },
            { value: 1, label: 'Last cycle', testID: 'insights-cycle-prev', activeTint: 'rgba(124,140,255,.16)', activeTextColor: C.accentSoft },
          ]}
        />

        {/* hero: where the money went in the selected cycle */}
        <View style={styles.hero}>
          <HeroGradientFill />
          <View style={styles.heroBlob} />
          <Text style={styles.heroEyebrow}>{cycle === 0 ? 'THIS PAY CYCLE' : 'LAST PAY CYCLE'}</Text>
          {/* Never show a confident "$0" over a load/error — the total reads breakdown,
              which isn't ready yet. A legit zero-spend cycle (loaded, no rows) still
              shows $0. WHIT-189. */}
          {showSpinner || showError ? (
            <>
              <Text style={styles.heroTotal}>—</Text>
              <Text style={styles.heroSub}>{showError ? "Couldn't load" : 'Loading…'}</Text>
            </>
          ) : (
            <>
              <Text testID="insights-hero-total" style={styles.heroTotal}>{fmt(total)}</Text>
              <Text style={styles.heroSub}>spent across {topLevelCount} {topLevelCount === 1 ? 'category' : 'categories'}</Text>
            </>
          )}
        </View>

        {/* AI "coach" card (WHIT-104). WHIT-68: it's a CURRENT-cycle tool, so it's hidden
            while viewing a past cycle rather than showing advice that contradicts the
            "LAST PAY CYCLE" hero. Self-contained (reads the AI slice + goal itself). */}
        {cycle === 0 && <AiCoachCard />}

        {showSpinner && (
          <View testID="insights-loading" style={styles.rowsState}>
            <ActivityIndicator color={C.accent} />
          </View>
        )}
        {showError && (
          <View testID="insights-error" style={styles.rowsState}>
            <Text style={styles.empty}>Couldn't load your spending.</Text>
            <RetryButton onPress={refetch} label="Retry loading your insights" testID="insights-retry" style={styles.retryBtn} textStyle={styles.retryText} />
          </View>
        )}
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
          <EarnedVsSpent earned={earned} spent={total} testID="insights-earned-spent" />
        )}

        {/* WHIT-373: one list, a switch — Spending shows the category breakdown, Earning shows the
            same cycle's income sources. Only shown when a side has content (else it's a dead switch). */}
        {showToggle && (
          <SegmentedControl
            value={side}
            onChange={setSideChoice}
            options={[
              { value: 'spending', label: 'Spending', testID: 'insights-side-spending', activeTint: tint(C.bad, 0.16), activeTextColor: C.bad },
              { value: 'earning', label: 'Earning', testID: 'insights-side-earning', activeTint: tint(C.good, 0.16), activeTextColor: C.good },
            ]}
          />
        )}

        {/* Spending side: each row's bar is its share of total spend this cycle (matches the donut) —
            NOT spend-vs-budget. Caption it so the short bars aren't read as "budget barely used". */}
        {!showSpinner && !showError && side === 'spending' && rows.length > 0 && (
          <Text testID="insights-bars-caption" style={styles.barsCaption}>
            Each bar shows the category's share of total spend — not its budget.
          </Text>
        )}
        {!showSpinner && !showError && side === 'spending' && rows.length === 0 && (
          <Text style={styles.empty}>
            {cycle === 0 ? 'No spending yet this pay cycle.' : 'No spending in that pay cycle.'}
          </Text>
        )}

        {/* WHIT-194: suppress the row list under an error — otherwise the surviving
            taxonomy-free Uncategorized row would render beneath the "Couldn't load" card. */}
        {!showError && side === 'spending' && visibleRows.map((r) => {
          // WHIT-349/357: a muted display-only line under an expanded parent — no bar. A refund
          // line shows a credit in green and taps into that sub's charges. A WHIT-357 "Other" line
          // plugs the residual so the expanded rows sum to the node; it is neutral and NOT tappable
          // (it isn't a real category, so there is nothing to drill into).
          if (r.isRefund || r.isRemainder) {
            // WHIT-375: the refund/"Other" amount + colours come from the one shared convention
            // (see breakdownLineStyle) so this can't drift from the breakdown screen again.
            const { amountText, amountColor, nameColor } = breakdownLineStyle(r);
            const body = (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
                <View style={[styles.chip, { backgroundColor: r.chipBg }]}><Icon name={r.icon} size={23} color={r.color} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.rowName, { color: nameColor }]} numberOfLines={1}>{r.name}</Text>
                  <Text style={styles.rowSub}>{r.spentLabel}</Text>
                </View>
                <Text style={[styles.rowAmount, { color: amountColor }]}>{amountText}</Text>
              </View>
            );
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
                style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}
              >
                <View style={[styles.chip, { backgroundColor: r.chipBg }]}><Icon name={r.icon} size={23} color={r.color} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                  <Text style={styles.rowSub}>{r.spentLabel}</Text>
                </View>
                {r.hasChildren && <Icon name={open ? 'chevronDown' : 'chevron'} size={18} color={C.textDim} />}
                <Text style={styles.rowAmount}>{fmt(r.spent)}</Text>
              </Pressable>
              <View style={styles.track}>
                <View style={{ width: `${postedW}%`, backgroundColor: r.color, height: '100%', borderRadius: 5 }} />
                {pendingW > 0 && (
                  <View style={{ width: `${pendingW}%`, backgroundColor: tint(r.color, 0.45), height: '100%', borderRadius: 5 }} />
                )}
              </View>
            </View>
          );
        })}

        {/* Earning side: one row per income source, biggest first, each with a green bar for its
            share of total income. WHIT-373 folds in the retired /breakdown earned view. */}
        {!showSpinner && !showError && side === 'earning' && incomeRows.length > 0 && (
          <Text testID="insights-income-caption" style={styles.barsCaption}>
            Each bar shows the source's share of total income.
          </Text>
        )}
        {!showSpinner && !showError && side === 'earning' && incomeRows.length === 0 && (
          <Text style={styles.empty}>
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
              <View style={[styles.chip, { backgroundColor: r.chipBg }]}><Icon name={r.icon} size={23} color={r.color} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.rowName, { color: nameColor }]} numberOfLines={1}>{r.name}</Text>
                {r.pending > 0 && <Text style={styles.rowSub}>{fmt(r.pending)} pending</Text>}
              </View>
              <Text style={[styles.rowAmount, { color: amountColor }]}>{amountText}</Text>
            </View>
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
  );
}

const styles = StyleSheet.create({
  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 24, paddingTop: 26, paddingBottom: 22, marginBottom: 22, backgroundColor: C.accent },
  heroBlob: { position: 'absolute', right: -30, top: -30, width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(255,255,255,.12)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: 'rgba(20,18,50,.65)', letterSpacing: 0.2 },
  heroTotal: { fontFamily: FONT.display, fontSize: 40, fontWeight: '800', color: C.heroInk, letterSpacing: -1.5, marginTop: 4 },
  heroSub: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.heroInk2, marginTop: 2 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, paddingBottom: 14, marginBottom: 12 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright, letterSpacing: -0.4 },
  track: { flexDirection: 'row', gap: 2, height: 8, marginTop: 14, backgroundColor: 'rgba(255,255,255,.05)', borderRadius: 5, overflow: 'hidden' },

  barsCaption: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, textAlign: 'center', marginTop: -6, marginBottom: 16 },
  empty: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, textAlign: 'center', paddingVertical: 40 },
  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 14 },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
