import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, transactionView, Transaction, Category } from '../context';

// WHIT-203: the category taxonomy comes in as a prop (from the screen's query composite),
// so the row doesn't read the store for it. openPicker stays on the store (client-state).
export function TransactionRow({ t, category }: { t: Transaction; category: (id: string | null) => Category | undefined }) {
  const s = useAppContext();
  const v = transactionView({ category }, t);
  const onPress = v.tappable ? () => s.openPicker(t.transaction_id) : undefined;
  return (
    <Pressable
      onPress={onPress}
      disabled={!v.tappable}
      // WHIT-184 taste: a tappable row dims on press so it doesn't feel dead. A
      // disabled (non-tappable) row never enters the pressed state, so it stays solid.
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
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
        </View>
      </View>
      <Text style={[styles.amount, { color: v.amountColor }]}>{v.amountLabel}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 13, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: C.hairline },
  rowPressed: { opacity: 0.6 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  merchant: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  category: { fontFamily: FONT.body, fontSize: 12.5 },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(255,255,255,.06)', paddingVertical: 2, paddingLeft: 5, paddingRight: 7, borderRadius: 6 },
  pendingText: { fontFamily: FONT.body, fontSize: 11, color: '#8b8b95' },
  amount: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
});
