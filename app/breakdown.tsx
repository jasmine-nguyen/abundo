import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, tint, breakdownLineStyle } from '../src/theme';
import { Icon } from '../src/icons';
import { categoryBreakdown } from '../src/context';
import { useInsightsScreenData } from '../src/queries';
import { Header } from '../src/components/Header';
import { DetailStates } from '../src/components/DetailStates';

// WHIT-366: the shared "drill into Earned / Spent" screen, opened from the Insights Earned-vs-Spent
// card. `kind` picks the side, `cycle` the pay cycle (0 = this, 1 = last), and `parent` (spend only)
// the sub-level when drilling into a spending group. Both sides render the SAME list — one row per
// thing inside the number, biggest first — so Earned and Spent behave identically:
//   • Earned → income sources (Salary, side income, …). Income is flat, so a source always drills
//     straight into its transactions (/category/[id]).
//   • Spent  → spending groups. A group with sub-categories drills one level deeper (this screen
//     again, with `parent` set); a single category drills into its transactions. This reuses the
//     categoryBreakdown selector the Insights list already builds — no second copy of the logic.
//
// A row shape shared by both sides so the list renders once.
type BreakdownItem = {
  key: string;
  name: string;
  color: string;
  icon: string;
  chipBg: string;
  amount: number;
  pending: number;
  onPress?: () => void;   // absent ⇒ not tappable (a synthetic "Other" plug)
  credit?: boolean;       // a refund line — amount reads as an unsigned credit in green
  muted?: boolean;        // a synthetic "Other" plug — dimmed, not a real category
};

const INCOME_FALLBACK_ICON = 'briefcase';

export default function Breakdown() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { kind: kindParam, cycle, parent } = useLocalSearchParams<{ kind?: string; cycle?: string; parent?: string }>();
  const kind = kindParam === 'earned' ? 'earned' : 'spent';
  // Floor + clamp to {0,1} — the only cycles Insights pushes — so a stale/hand-edited deep-link
  // can't request an older window or mislabel it (same guard as app/category/[id].tsx).
  const cycleNum = Math.min(1, Math.max(0, Math.floor(Number(cycle) || 0)));

  const { earned, incomeSources, breakdown, category, isLoading, isError, refetch } = useInsightsScreenData(cycleNum);

  let items: BreakdownItem[];
  let title: string;
  let headlineAmount: number;
  let countLabel: string;
  let emptyText: string;

  if (kind === 'earned') {
    // Each income source joins the taxonomy for its name/icon/colour; fall back safely when the
    // categories query hasn't caught up with the breakdown (they fetch in parallel).
    items = incomeSources.map((source) => {
      const c = category(source.id);
      const color = c?.color ?? C.good;
      return {
        key: source.id,
        name: c?.name ?? 'Income',
        color,
        icon: c?.icon ?? INCOME_FALLBACK_ICON,
        chipBg: tint(color, 0.15),
        amount: source.amount,
        pending: source.pending,
        onPress: () => router.push(`/category/${encodeURIComponent(source.id)}?cycle=${cycleNum}`),
      };
    });
    title = 'Income';
    headlineAmount = earned;   // the __earned__ headline the Insights card shows (rows sum to it on clean data)
    countLabel = `${items.length} ${items.length === 1 ? 'income source' : 'income sources'}`;
    emptyText = 'No income recorded for this cycle.';
  } else {
    const { rows, total } = categoryBreakdown({ breakdown, category });
    const level = parent ?? null;
    const levelRows = rows.filter((r) => r.parentId === level);
    items = levelRows.map((r) => {
      // A synthetic "Other" plug isn't a real category — show it muted and not tappable.
      if (r.isRemainder) {
        return { key: r.id, name: r.name, color: C.textDim, icon: r.icon, chipBg: r.chipBg, amount: r.spent, pending: r.pending, muted: true };
      }
      // A refund line reads as an unsigned green credit and taps into that member's charges.
      if (r.isRefund) {
        return {
          key: r.id, name: r.name, color: C.good, icon: r.icon, chipBg: r.chipBg,
          amount: r.spent, pending: r.pending, credit: true,
          onPress: () => router.push(`/category/${encodeURIComponent(r.drillId)}?cycle=${cycleNum}`),
        };
      }
      // A group drills one level deeper; a single category drills into its transactions.
      const onPress = r.hasChildren
        ? () => router.push(`/breakdown?kind=spent&cycle=${cycleNum}&parent=${encodeURIComponent(r.id)}`)
        : () => router.push(`/category/${encodeURIComponent(r.drillId)}?cycle=${cycleNum}`);
      return { key: r.id, name: r.name, color: r.color, icon: r.icon, chipBg: r.chipBg, amount: r.spent, pending: r.pending, onPress };
    });
    const parentRow = level ? rows.find((r) => r.id === level) : null;
    title = parentRow?.name ?? 'Spending';
    headlineAmount = parentRow ? parentRow.spent : total;
    // Count only real categories — the synthetic "Other" plug isn't one.
    const categoryCount = items.filter((i) => !i.muted).length;
    countLabel = `${categoryCount} ${categoryCount === 1 ? 'category' : 'categories'}`;
    emptyText = 'No spending in this cycle.';
  }

  const headlineLabel = `${kind === 'earned' ? 'Earned' : 'Spent'} ${cycleNum === 0 ? 'this cycle' : 'last cycle'}`;
  const headlinePending = items.reduce((sum, i) => (i.credit ? sum : sum + i.pending), 0);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={title} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        <DetailStates
          isLoading={isLoading}
          isError={isError}
          hasCache={items.length > 0}
          idPrefix="breakdown"
          errorText="Couldn't load your breakdown."
          retryLabel="Retry loading this breakdown"
          onRetry={refetch}
        >
          {items.length > 0 ? (
            <>
              <View testID="breakdown-total" style={styles.totalCard}>
                <Text style={styles.totalLabel}>{headlineLabel}</Text>
                <Text style={styles.totalAmount}>{fmt(headlineAmount)}</Text>
                {headlinePending > 0 && <Text style={styles.totalPending}>{fmt(headlinePending)} pending</Text>}
              </View>
              <Text style={styles.count}>{countLabel}</Text>
              {items.map((item) => {
                // WHIT-375: amount text + colours come from the one shared convention (see
                // breakdownLineStyle) — the same rule the Insights list uses. `credit`/`muted`/
                // `amount` map to the helper's `isRefund`/`isRemainder`/`spent`.
                const { amountText, amountColor, nameColor } = breakdownLineStyle({ isRefund: item.credit, isRemainder: item.muted, spent: item.amount });
                const body = (
                  <View style={styles.rowBody}>
                    <View style={[styles.chip, { backgroundColor: item.chipBg }]}>
                      <Icon name={item.icon} size={23} color={item.color} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.rowName, { color: nameColor }]} numberOfLines={1}>{item.name}</Text>
                      {item.pending > 0 && <Text style={styles.rowSub}>{fmt(item.pending)} pending</Text>}
                    </View>
                    {item.onPress && <Icon name="chevron" size={18} color={C.textDim} />}
                    <Text style={[styles.rowAmount, { color: amountColor }]}>{amountText}</Text>
                  </View>
                );
                if (!item.onPress) return <View key={item.key} style={styles.row}>{body}</View>;
                return (
                  <Pressable
                    key={item.key}
                    onPress={item.onPress}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    {body}
                  </Pressable>
                );
              })}
            </>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{kind === 'earned' ? 'No income' : 'No spending'}</Text>
              <Text style={styles.emptySub}>{emptyText}</Text>
            </View>
          )}
        </DetailStates>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  totalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 18, marginTop: 6 },
  totalLabel: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.textMid, letterSpacing: 0.2 },
  totalAmount: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.textBright, letterSpacing: -0.6, marginTop: 4 },
  totalPending: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 6 },

  count: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 16, marginBottom: 4, marginHorizontal: 4 },

  row: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, marginBottom: 12 },
  rowPressed: { opacity: 0.6 },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  rowSub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  rowAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', letterSpacing: -0.4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
