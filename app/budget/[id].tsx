import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { budgetDetail, transactionView, Transaction, Category, useAppContext } from '../../src/context';
import { useBudgetDetailScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { WhittleBar } from '../../src/components/ui';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';

export default function BudgetDetail() {
  // WHIT-203: the rollup + this category's transactions now come from the cached query
  // layer (fed to budgetDetail as a narrow input) instead of the eager store.
  const d = useBudgetDetailScreenData();
  const s = useAppContext(); // deleteBudget writer stays on the store
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const bd = budgetDetail(d, id);
  const [deleting, setDeleting] = useState(false);
  // WHIT-241: same-frame double-tap guard on Delete (declared with the other hooks, above the
  // early returns below, to satisfy the rules of hooks).
  const runDelete = useInFlightGuard();

  const onDelete = () => runDelete(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const ok = await s.deleteBudget(id);
      // On success the budget is gone from the Budgets tab; go back to it. On failure the
      // writer toasts — stay on the screen so the user can retry.
      if (ok) router.back();
      else setDeleting(false);
    } catch (error) {
      setDeleting(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  // WHIT-72: a first-load pay-cycle failure would render the detail's pace/projection
  // against the DEFAULT cycle (wrong). This screen is reached from the Budgets tab (which
  // now shows its error on payCycleError), so blanking here only guards a direct deep-link.
  if (!bd || d.payCycleError) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
        <Header title="Budget" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header
        title="Budget"
        right={
          <Pressable onPress={() => router.push(`/budget/edit?categoryId=${id}&from=detail`)}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={[styles.chip, { backgroundColor: bd.color }]}><Icon name={bd.icon} size={32} color={C.heroInk} /></View>
            <View>
              <Text style={styles.name}>{bd.name}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
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
            <WhittleBar postedPct={bd.postedPct} pendingPct={bd.pendingPct} targetPct={bd.targetPct} postedColor={bd.postedColor} pendingTint={bd.pendingTint} height={12} />
            <View style={styles.targetRow}>
              <Text style={[styles.targetLabel, { left: `${bd.targetPct}%` }]}>today's target</Text>
            </View>
          </View>

          <View style={styles.dailyBox}>
            <Glyph name="clock" size={20} color={C.accentSoft} />
            <Text style={styles.dailyText}>{bd.dailyLabel}</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>RELATED TRANSACTIONS</Text>
        {bd.relGroups.map((g) => (
          <View key={g.label} style={{ marginTop: 6 }}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            {g.items.map((t) => <DetailTransactionRow key={t.transaction_id} t={t} category={d.category} />)}
          </View>
        ))}
        {bd.relEmpty && <Text style={styles.empty}>No transactions in this category this cycle.</Text>}

        <Pressable testID="budget-delete" onPress={onDelete} disabled={deleting} style={[styles.deleteBtn, deleting && { opacity: 0.6 }]}>
          <Text style={styles.deleteText}>{deleting ? 'Removing…' : 'Delete budget'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function DetailTransactionRow({ t, category }: { t: Transaction; category: (id: string | null) => Category | undefined }) {
  const v = transactionView({ category }, t);
  const c = category(t.category);
  return (
    <View style={styles.txRow}>
      <View style={[styles.txChip, { backgroundColor: v.chipBg }]}><Icon name={v.icon} size={22} color={v.iconColor} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.txMerchant} numberOfLines={1}>{v.merchant}</Text>
        <View style={styles.txStatus}>
          {v.isPending ? (
            <><Glyph name="clock" size={12} color="#8b8b95" /><Text style={styles.txStatusText}>Pending</Text></>
          ) : (
            <><Glyph name="check" size={12} color="#8b8b95" /><Text style={styles.txStatusText}>Posted</Text></>
          )}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.txAmount, { color: v.amountColor }]}>{v.amountLabel}</Text>
        <Text style={styles.txBucket}>{c ? c.bucket : 'Uncategorized'}</Text>
      </View>
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
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  status: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700' },
  daysLeft: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim },
  targetRow: { position: 'relative', height: 16, marginTop: 1 },
  targetLabel: { position: 'absolute', top: 4, transform: [{ translateX: -32 }], fontFamily: FONT.body, fontSize: 10, color: '#73737d', fontWeight: '500' },
  dailyBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(124,140,255,.1)', borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, marginTop: 16 },
  dailyText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.accentSofter },
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 22, marginBottom: 4, marginHorizontal: 4 },
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, marginHorizontal: 4, marginBottom: 2, marginTop: 8 },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.hairline },
  txChip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  txMerchant: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  txStatus: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  txStatusText: { fontFamily: FONT.body, fontSize: 12, color: '#8b8b95' },
  txAmount: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  txBucket: { fontFamily: FONT.body, fontSize: 11.5, color: C.textDim, marginTop: 2 },
  empty: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', paddingVertical: 30 },
  deleteBtn: { marginTop: 24, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  deleteText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
});
