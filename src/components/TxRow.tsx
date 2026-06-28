import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, txView, Txn } from '../context';

export function TxRow({ t }: { t: Txn }) {
  const s = useAppContext();
  const v = txView(s, t);
  const onPress = v.tappable ? () => s.openPicker(t.transaction_id) : undefined;
  return (
    <Pressable onPress={onPress} style={styles.row} disabled={!v.tappable}>
      <View style={[styles.chip, { backgroundColor: v.chipBg }]}>
        <Icon name={v.icon} size={22} color={v.iconColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.merchant} numberOfLines={1}>{v.merchant}</Text>
        <View style={styles.metaRow}>
          <Text style={[styles.cat, { color: v.catColor, fontWeight: v.catWeight }]}>{v.catLabel}</Text>
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
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  merchant: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  cat: { fontFamily: FONT.body, fontSize: 12.5 },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(255,255,255,.06)', paddingVertical: 2, paddingLeft: 5, paddingRight: 7, borderRadius: 6 },
  pendingText: { fontFamily: FONT.body, fontSize: 11, color: '#8b8b95' },
  amount: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
});
