import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, transactionView, Transaction, Category } from '../context';

// WHIT-203: the category taxonomy comes in as a prop (from the screen's query composite),
// so the row doesn't read the store for it. openPicker stays on the store (client-state).
// WHIT-272: the row body keeps its tap-to-categorise behaviour; a separate trailing chevron
// (its own Pressable, so pressing it never fires the body press) opens the detail page.
// WHIT-291: in the Transactions selection mode (`selectable`), the row is a checkbox instead —
// the whole row toggles selection, and the single-tap categorise + detail chevron are suppressed.
export function TransactionRow({ t, category, selectable = false, selected = false, onToggleSelect }: {
  t: Transaction;
  category: (id: string | null) => Category | undefined;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const s = useAppContext();
  const router = useRouter();
  const v = transactionView({ category }, t);
  const onPress = selectable ? onToggleSelect : (v.tappable ? () => s.openPicker(t.transaction_id) : undefined);
  return (
    <View style={[styles.row, selectable && selected && styles.rowSelected]}>
      {selectable && (
        <Pressable
          onPress={onToggleSelect}
          hitSlop={6}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected }}
          accessibilityLabel={`Select ${v.merchant}`}
          style={styles.check}
        >
          <View style={[styles.checkBox, selected && styles.checkBoxOn]}>
            {selected && <Glyph name="check" size={13} color={C.accentInk} />}
          </View>
        </Pressable>
      )}
      <Pressable
        onPress={onPress}
        // In selection mode the whole row is always pressable (toggles selection). Otherwise a
        // non-tappable (categorized) row stays disabled so it never dims (WHIT-184 taste).
        disabled={selectable ? false : !v.tappable}
        // In selection mode the labelled checkbox is the SOLE accessibility target for the row —
        // hide this body (merchant/amount) from assistive tech so a screen reader doesn't stop on
        // an unlabelled second tap target. The whole-row tap still works for sighted users.
        accessibilityElementsHidden={selectable}
        importantForAccessibility={selectable ? 'no-hide-descendants' : 'auto'}
        style={({ pressed }) => [styles.body, pressed && styles.rowPressed]}
      >
        <View style={[styles.chip, { backgroundColor: v.chipBg }]}>
          <Icon name={v.icon} size={22} color={v.iconColor} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.merchant} numberOfLines={1}>{v.merchant}</Text>
          <View style={styles.metaRow}>
            <Text style={[styles.category, { color: v.categoryColor, fontWeight: v.categoryWeight }]}>{v.categoryLabel}</Text>
            {v.isPending && (
              <View style={styles.pending}>
                <Glyph name="clock" size={12} color="#8b8b95" />
                <Text style={styles.pendingText}>Pending</Text>
              </View>
            )}
            {/* WHIT-298: a quiet tag on charges that don't count toward budgets (a bank
                transfer / card payment, or one the user excluded). */}
            {v.excluded && (
              <View style={styles.excluded} accessible accessibilityLabel="Not counted in budgets">
                <Text style={styles.excludedText}>Not in budget</Text>
              </View>
            )}
          </View>
        </View>
        <Text style={[styles.amount, { color: v.amountColor }]}>{v.amountLabel}</Text>
      </Pressable>
      {!selectable && (
        <Pressable
          onPress={() => router.push(`/transaction/${t.transaction_id}`)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="View transaction details"
          style={styles.chevron}
        >
          <Glyph name="chevron" size={18} color={C.textFaint} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.hairline },
  // WHIT-291: a faint accent wash marks a selected row in selection mode.
  rowSelected: { backgroundColor: 'rgba(124,140,255,.10)' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 13, paddingLeft: 6 },
  rowPressed: { opacity: 0.6 },
  check: { paddingLeft: 6, paddingRight: 2, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  checkBox: { width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: C.hairlineStrong, alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: C.accent, borderColor: C.accent },
  chevron: { paddingVertical: 13, paddingLeft: 8, paddingRight: 6, alignItems: 'center', justifyContent: 'center' },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  merchant: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  category: { fontFamily: FONT.body, fontSize: 12.5 },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(255,255,255,.06)', paddingVertical: 2, paddingLeft: 5, paddingRight: 7, borderRadius: 6 },
  pendingText: { fontFamily: FONT.body, fontSize: 11, color: '#8b8b95' },
  // WHIT-298: same quiet pill as Pending, text-only (no glyph, so it never implies a wrong icon).
  excluded: { backgroundColor: 'rgba(255,255,255,.06)', paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6 },
  excludedText: { fontFamily: FONT.body, fontSize: 11, color: C.textDim },
  amount: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
});
