import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { useAppContext, txGroups, uncatCount } from '../../src/context';
import { TxRow } from '../../src/components/TxRow';

type Tab = 'all' | 'uncat' | 'accounts';

const ACCOUNTS = [
  { name: 'Spending', sub: 'Everyday account', balance: '$1,284.50', balColor: '#f1f1f4', icon: 'cart', color: '#7FD49B' },
  { name: 'Savings', sub: 'Goal: House deposit', balance: '$96,416', balColor: '#cfd2ff', icon: 'home', color: '#8AB4F8' },
  { name: 'Home loan', sub: 'Up Home Loan', balance: '−$412,900', balColor: '#ff6b6b', icon: 'home', color: '#F08C8C' },
];

export default function Transactions() {
  const s = useAppContext();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('all');
  const uncat = uncatCount(s);
  const groups = txGroups(s, tab === 'uncat' ? 'uncat' : 'all');

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View style={{ width: 40 }} />
        <Text style={styles.headerTitle}>Transactions</Text>
        <View style={styles.searchBtn}><Glyph name="search" size={20} color={C.textMid} /></View>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* segmented control */}
        <View style={styles.seg}>
          <Seg label="All" active={tab === 'all'} onPress={() => setTab('all')} flex={1} />
          <Seg label="Uncategorized" active={tab === 'uncat'} onPress={() => setTab('uncat')} flex={1.45} badge={uncat} />
          <Seg label="Accounts" active={tab === 'accounts'} onPress={() => setTab('accounts')} flex={1} />
        </View>

        {tab !== 'accounts' && (
          <View style={styles.search}>
            <Glyph name="search" size={18} color="#6e6e78" />
            <Text style={styles.searchText}>Search transactions</Text>
          </View>
        )}

        {tab === 'uncat' && uncat > 0 && (
          <View style={styles.hint}>
            <Glyph name="star" size={18} color={C.accentSoft} />
            <Text style={styles.hintText}>
              Tap a transaction to categorize it — and choose whether the call applies to{' '}
              <Text style={styles.hintBold}>just that one</Text> or <Text style={styles.hintBold}>every charge</Text> from that merchant.
            </Text>
          </View>
        )}

        {tab !== 'accounts' && groups.map((g) => (
          <View key={g.label} style={{ marginTop: 18 }}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            {g.items.map((t) => <TxRow key={t.transaction_id} t={t} />)}
          </View>
        ))}

        {tab === 'uncat' && uncat === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="check" size={32} color={C.good} /></View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Every transaction is categorized. New ones matching your rules file themselves automatically.</Text>
          </View>
        )}

        {tab === 'accounts' && (
          <View style={{ marginTop: 14 }}>
            {ACCOUNTS.map((a) => (
              <View key={a.name} style={styles.acct}>
                <View style={[styles.acctChip, { backgroundColor: tint(a.color, 0.15) }]}><Icon name={a.icon} size={22} color={a.color} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.acctName}>{a.name}</Text>
                  <Text style={styles.acctSub}>{a.sub}</Text>
                </View>
                <Text style={[styles.acctBal, { color: a.balColor }]}>{a.balance}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Seg({ label, active, onPress, flex, badge }: { label: string; active: boolean; onPress: () => void; flex: number; badge?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.segBtn, { flex, backgroundColor: active ? '#fff' : 'transparent' }]}>
      <Text style={[styles.segText, { color: active ? '#13132e' : C.textMid }]}>{label}</Text>
      {badge !== undefined && (
        <View style={[styles.badge, { backgroundColor: active ? 'rgba(19,19,46,.18)' : 'rgba(255,107,107,.2)' }]}>
          <Text style={[styles.badgeText, { color: active ? '#13132e' : '#ff8e8e' }]}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
  headerTitle: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: '#fff', letterSpacing: -0.2 },
  searchBtn: { width: 40, height: 40, backgroundColor: 'rgba(255,255,255,.06)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  seg: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: C.card, borderRadius: 14, marginBottom: 8 },
  segBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10 },
  segText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700' },

  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingVertical: 11, paddingHorizontal: 14, marginTop: 8 },
  searchText: { fontFamily: FONT.body, fontSize: 14, color: '#6e6e78' },

  hint: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', backgroundColor: 'rgba(124,140,255,.1)', borderWidth: 1, borderColor: 'rgba(124,140,255,.22)', borderRadius: 16, padding: 13, paddingHorizontal: 14, marginTop: 10 },
  hintText: { flex: 1, fontFamily: FONT.body, fontSize: 12.5, color: C.accentSofter, lineHeight: 18 },
  hintBold: { color: '#fff', fontWeight: '700' },

  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(53,217,160,.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },

  acct: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginBottom: 10 },
  acctChip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  acctName: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  acctSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  acctBal: { fontFamily: FONT.display, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
});
