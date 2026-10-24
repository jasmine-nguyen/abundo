import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../theme';
import { Icon, Glyph } from '../icons';
import { budgetDetail, groupTransactionsByDate, useAppContext } from '../context';
import { useBudgetDetailScreenData } from '../queries';
import { Header } from '../components/Header';
import { TransactionRow } from '../components/TransactionRow';
import { LoadMoreButton } from '../components/LoadMoreButton';
import { BudgetBar, DeleteLink, SectionLabel } from '../components/ui';
import { useInFlightGuard } from '../hooks/useInFlightGuard';
import { useScrollEdge } from '../hooks/useScrollEdge';
import { usePageSidePadding } from '../hooks/useHeaderSidePadding';
import { confirmDelete } from '../confirmDelete';
import { TAB_BAR_CLEARANCE } from '../motion/ScrollChromeHeader';

// How many related-transaction rows to show before the "Load More" button.
const BUDGET_TX_PAGE = 7;

// ABU-113: `onClose` given = shown in the wide-screen pane beside the Budgets list — no back
// arrow, and a delete (or the budget leaving the list) calls `onClose` instead of going back.
export function BudgetDetailView({ id, onClose }: { id: string; onClose?: () => void }) {
  const embedded = onClose !== undefined;
  // WHIT-203: the rollup comes from the cached query layer. The related list is now this
  // budget's whole-cycle subtree, fetched server-side so it sums to the header total.
  const d = useBudgetDetailScreenData(id);
  const s = useAppContext(); // deleteBudget writer stays on the store
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const edge = useScrollEdge();
  const pagePadding = usePageSidePadding();
  const bd = budgetDetail(d, id);
  const [deleting, setDeleting] = useState(false);
  // How many related rows are revealed; "Load More" reveals the next page.
  const [visibleCount, setVisibleCount] = useState(BUDGET_TX_PAGE);
  // WHIT-241: same-frame double-tap guard on Delete (declared with the other hooks, above the
  // early returns below, to satisfy the rules of hooks).
  const runDelete = useInFlightGuard();

  const onConfirmDelete = () => runDelete(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const ok = await s.deleteBudget(id);
      // On success the budget is gone from the Budgets tab; go back to it. On failure the
      // writer toasts — stay on the screen so the user can retry.
      if (!ok) setDeleting(false);
      else if (embedded) onClose?.();
      else router.back();
    } catch (error) {
      setDeleting(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  const onDelete = () => confirmDelete(
    'Delete this budget?',
    "Its spending limit will be removed. The category and its transactions stay. This can't be undone.",
    onConfirmDelete,
  );

  // A pane budget that left the list (removed elsewhere) closes the pane. Not while deleting, nor
  // before the first load lands.
  const gone = embedded && !bd && !deleting && !d.isLoading;
  useEffect(() => {
    if (gone) onClose?.();
  }, [gone, onClose]);
  if (gone) return null;

  // WHIT-72: a first-load pay-cycle failure would render the detail's pace/projection
  // against the DEFAULT cycle (wrong). This screen is reached from the Budgets tab (which
  // now shows its error on payCycleError), so blanking here only guards a direct deep-link.
  if (!bd || d.payCycleError) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
        <Header title="Budget" back={!embedded} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header
        title="Budget"
        divider={edge.scrolled}
        back={!embedded}
        right={
          <Pressable onPress={() => router.push(`/budget/edit?categoryId=${id}&from=detail`)}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        }
      />
      <ScrollView {...edge.scrollProps} contentContainerStyle={{ ...pagePadding, paddingBottom: embedded ? TAB_BAR_CLEARANCE : insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={[styles.chip, { backgroundColor: bd.color }]}><Icon name={bd.icon} size={32} color={C.heroInk} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.name}>{bd.name}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6 }}>
                <Text style={styles.spentBig}>{bd.spentBig}</Text>
                <Text style={styles.ofBudget}>{bd.ofBudget}</Text>
              </View>
            </View>
          </View>

          <View style={{ marginTop: 18 }}>
            <View style={styles.statusRow}>
              <Text style={[styles.status, { color: bd.statusColor }]}>{bd.statusLabel}</Text>
              <Text style={styles.daysLeft}>{bd.daysLeftLabel}</Text>
            </View>
            <BudgetBar postedPct={bd.postedPct} pendingPct={bd.pendingPct} targetPct={bd.targetPct} postedColor={bd.postedColor} pendingTint={bd.pendingTint} height={12} showTarget={bd.showTarget} />
            {bd.showTarget ? (
              <View style={styles.targetRow}>
                <Text style={[styles.targetLabel, { left: `${bd.targetPct}%` }]}>today's plan</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.dailyBox}>
            <Glyph name="clock" size={20} color={C.accentSoft} />
            <Text style={styles.dailyText}>{bd.dailyLabel}</Text>
          </View>

          {bd.carryoverLine ? (
            <View style={styles.carryoverBox}>
              <Glyph name="refresh" size={18} color={C.accentSoft} />
              <View style={styles.carryoverBody}>
                <Text style={styles.carryoverText}>{bd.carryoverLine}</Text>
                {bd.carryoverCycleLines.map((line, i) => (
                  <View key={line.key} style={styles.cycleRow} testID={`carryover-cycle-${i}`}>
                    <Text style={styles.cycleLabel}>
                      {line.label}
                      {line.settling ? <Text style={styles.cycleTag}>  settling</Text> : null}
                      {line.rebuilt ? <Text style={styles.cycleTag}>  estimated</Text> : null}
                    </Text>
                    <Text style={styles.cycleAmount}>{line.amount}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <SectionLabel style={{ marginTop: 22, marginBottom: 4 }}>RELATED TRANSACTIONS</SectionLabel>
        {groupTransactionsByDate(bd.relItems.slice(0, visibleCount)).map((g) => (
          <View key={g.label} style={{ marginTop: 6 }}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            {g.items.map((t) => <TransactionRow key={t.transaction_id} t={t} category={d.category} />)}
          </View>
        ))}
        {bd.relItems.length > visibleCount && (
          <LoadMoreButton testID="budget-load-more" onPress={() => setVisibleCount((n) => n + BUDGET_TX_PAGE)} style={styles.loadMore} />
        )}
        {bd.relEmpty && !d.isLoading && <Text style={styles.empty}>No transactions in this category this cycle.</Text>}

        <DeleteLink testID="budget-delete" label="Delete budget" busy={deleting} busyLabel="Removing…" onPress={onDelete} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  edit: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft, paddingHorizontal: 4 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 18 },
  chip: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  spentBig: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  ofBudget: { fontFamily: FONT.body, fontSize: 14, color: C.textDim },
  // Wraps so a long status at large text drops the days onto the next line instead of running off the card (WHIT-743).
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 2, alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  status: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', flexShrink: 1 },
  daysLeft: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim },
  targetRow: { position: 'relative', height: 16, marginTop: 1 },
  targetLabel: { position: 'absolute', top: 4, transform: [{ translateX: -32 }], fontFamily: FONT.body, fontSize: 10, color: '#73737d', fontWeight: '500' },
  dailyBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: tint(C.accentAlt, 0.1), borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, marginTop: 16 },
  dailyText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.accentSofter },
  carryoverBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: tint(C.accentAlt, 0.1), borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, marginTop: 10 },
  carryoverText: { flexShrink: 1, fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.accentSofter },
  carryoverBody: { flex: 1, gap: 4 },
  // Wraps so a long cycle label at large text pushes the amount onto the next line (WHIT-743 pattern).
  cycleRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, justifyContent: 'space-between' },
  cycleLabel: { flexShrink: 1, fontFamily: FONT.body, fontSize: 12.5, color: C.textMid },
  cycleAmount: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.accentSofter },
  cycleTag: { fontSize: 11.5, color: C.textDim },
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, marginHorizontal: 4, marginBottom: 2, marginTop: 8 },
  empty: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', paddingVertical: 30 },
  loadMore: { marginTop: 14 },
});
