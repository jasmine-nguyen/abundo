import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, merchantLabel } from '../context';

export function Overlays() {
  const s = useAppContext();
  return (
    <>
      <NotifBanner />
      <Toast />
      <SheetHost />
      {/* picker -> confirm reuse the same modal stack via store.sheet */}
    </>
  );
}

function Toast() {
  const { toast } = useAppContext();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.toastWrap, { bottom: insets.bottom + 96 }]}>
      <View style={styles.toast}>
        <Text style={styles.toastText}>{toast}</Text>
      </View>
    </View>
  );
}

function NotifBanner() {
  const { notif, dismissNotif } = useAppContext();
  const insets = useSafeAreaInsets();
  if (!notif) return null;
  return (
    <View style={[styles.notifWrap, { top: insets.top + 8 }]}>
      <Pressable onPress={dismissNotif} style={styles.notif}>
        <View style={styles.notifIcon}>
          <View style={styles.notifLogo}>
            <Glyph name="check" size={16} color="#15123a" />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
              <Text style={styles.notifApp}>WHITTLE</Text>
              <Text style={styles.notifTime}>{notif.time}</Text>
            </View>
            <Text style={styles.notifBody}>{notif.body}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function SheetHost() {
  const s = useAppContext();
  const open = !!s.sheet;
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => s.setSheet(null)}>
      <Pressable style={styles.scrim} onPress={() => s.setSheet(null)}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />
          {s.sheet?.mode === 'picker' && <PickerSheet />}
          {s.sheet?.mode === 'confirm' && <ConfirmSheet />}
          {s.sheet?.mode === 'addrule' && <AddRuleSheet />}
          {s.sheet?.mode === 'paycycle' && <PayCycleSheet />}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PickerSheet() {
  const s = useAppContext();
  const sh = s.sheet;
  if (sh?.mode !== 'picker') return null;
  const tx = s.transactions.find((t) => t.transaction_id === sh.txId);
  if (!tx) return null;
  const categories = s.categories.filter((c) => c.bucket !== 'Income');
  return (
    <View>
      <Text style={styles.sheetTitle}>Categorize</Text>
      <Text style={styles.sheetMerchant}>{merchantLabel(tx)}</Text>
      <Text style={styles.sheetAmount}>{'-$' + Math.abs(tx.amount).toFixed(2)}</Text>
      <ScrollView style={{ maxHeight: 340, marginTop: 12 }}>
        {categories.map((c) => (
          <Pressable key={c.id} onPress={() => s.chooseCategory(c.id)} style={styles.pickRow}>
            <View style={[styles.pickChip, { backgroundColor: tint(c.color, 0.15) }]}>
              <Icon name={c.icon} size={19} color={c.color} />
            </View>
            <Text style={styles.pickName}>{c.name}</Text>
            <Glyph name="chevron" size={16} color={C.textFaint} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function ConfirmSheet() {
  const s = useAppContext();
  const sh = s.sheet;
  if (sh?.mode !== 'confirm') return null;
  const tx = s.transactions.find((t) => t.transaction_id === sh.txId);
  const c = s.category(sh.categoryId);
  if (!tx || !c) return null;
  return (
    <View>
      <View style={[styles.confirmChip, { backgroundColor: tint(c.color, 0.16) }]}>
        <Icon name={c.icon} size={26} color={c.color} />
      </View>
      <Text style={styles.confirmTitle}>File as {c.name}</Text>
      <Text style={styles.confirmSub}>
        Apply to just '{merchantLabel(tx)}', or set a rule so every charge from this merchant files itself?
      </Text>
      <Pressable onPress={() => s.applyCategory('all')} style={[styles.btn, styles.btnPrimary]}>
        <Text style={styles.btnPrimaryText}>Every {merchantLabel(tx)} charge</Text>
      </Pressable>
      <Pressable onPress={() => s.applyCategory('one')} style={[styles.btn, styles.btnGhost]}>
        <Text style={styles.btnGhostText}>Just this one</Text>
      </Pressable>
    </View>
  );
}

function AddRuleSheet() {
  const s = useAppContext();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const categories = s.categories.filter((c) => c.bucket !== 'Income');
  const canSave = pattern.trim().length > 0 && !!categoryId;
  return (
    <View>
      <Text style={styles.sheetTitle}>New rule</Text>
      <Text style={styles.fieldLabel}>WHEN DESCRIPTION CONTAINS</Text>
      <TextInput
        value={pattern}
        onChangeText={setPattern}
        autoCapitalize="characters"
        placeholder="e.g. NETFLIX"
        placeholderTextColor={C.placeholder}
        style={styles.input}
      />
      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>FILE IT AS</Text>
      <ScrollView style={{ maxHeight: 220, marginTop: 6 }}>
        <View style={styles.ruleCatWrap}>
          {categories.map((c) => {
            const sel = categoryId === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCategoryId(c.id)}
                style={[styles.ruleCatPill, { backgroundColor: sel ? tint(c.color, 0.14) : C.cardAlt, borderColor: sel ? c.color : 'rgba(255,255,255,.06)' }]}
              >
                <Icon name={c.icon} size={12} color={c.color} />
                <Text style={[styles.ruleCatText, { color: sel ? '#fff' : C.textMid }]}>{c.name}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <Pressable
        onPress={() => canSave && s.saveManualRule(pattern, categoryId!)}
        style={[styles.btn, { marginTop: 16, backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}
      >
        <Text style={[styles.btnPrimaryText, { color: canSave ? C.accentInk : '#6a6a90' }]}>Add rule</Text>
      </Pressable>
    </View>
  );
}

function PayCycleSheet() {
  const s = useAppContext();
  const opts = [{ n: 'Weekly', len: 7 }, { n: 'Fortnightly', len: 14 }, { n: 'Monthly', len: 30 }];
  return (
    <View>
      <Text style={styles.sheetTitle}>Pay cycle</Text>
      <Text style={styles.confirmSub}>Budgets reset and pace is measured across this period.</Text>
      <View style={{ marginTop: 14, gap: 10 }}>
        {opts.map((o) => {
          const sel = s.payCycle.length === o.len;
          return (
            <Pressable
              key={o.len}
              onPress={() => s.setPayCycleLength(o.len)}
              style={[styles.cycleRow, { backgroundColor: sel ? 'rgba(124,140,255,.14)' : C.cardAlt, borderColor: sel ? C.accent : 'rgba(255,255,255,.07)' }]}
            >
              <Text style={[styles.cycleText, { color: sel ? C.accentSofter : C.textMid }]}>{o.n}</Text>
              {sel && <Glyph name="check" size={18} color={C.accent} />}
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={() => s.setSheet(null)} style={[styles.btn, styles.btnPrimary, { marginTop: 16 }]}>
        <Text style={styles.btnPrimaryText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // toast
  toastWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 200 },
  toast: { maxWidth: '88%', backgroundColor: '#26262f', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', paddingVertical: 11, paddingHorizontal: 16, borderRadius: 14 },
  toastText: { fontFamily: FONT.body, color: '#f1f1f4', fontSize: 13.5, textAlign: 'center' },
  // notif
  notifWrap: { position: 'absolute', left: 12, right: 12, zIndex: 300 },
  notif: { backgroundColor: 'rgba(34,34,40,.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', borderRadius: 20, padding: 14 },
  notifIcon: { flexDirection: 'row', gap: 11, alignItems: 'flex-start' },
  notifLogo: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#35d9a0', alignItems: 'center', justifyContent: 'center' },
  notifApp: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: '#cfd2ff', letterSpacing: 0.4 },
  notifTime: { fontFamily: FONT.body, fontSize: 11, color: C.textDim },
  notifBody: { fontFamily: FONT.body, fontSize: 13.5, color: '#e6e6ea', lineHeight: 19 },
  // sheet
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: '#161620', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: 'rgba(255,255,255,.08)' },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.18)', marginBottom: 14 },
  sheetTitle: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: '#f4f4f6', letterSpacing: -0.3 },
  sheetMerchant: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 8 },
  sheetAmount: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: '#f1f1f4', marginTop: 2, letterSpacing: -0.5 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11 },
  pickChip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pickName: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#f1f1f4' },
  confirmChip: { width: 52, height: 52, borderRadius: 15, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  confirmTitle: { fontFamily: FONT.display, fontSize: 19, fontWeight: '700', color: '#f4f4f6', textAlign: 'center' },
  confirmSub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', lineHeight: 20, marginTop: 8 },
  btn: { paddingVertical: 15, borderRadius: 15, alignItems: 'center', marginTop: 10 },
  btnPrimary: { backgroundColor: C.accent },
  btnPrimaryText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)' },
  btnGhostText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#e2e2e8' },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 16, marginBottom: 7 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  ruleCatWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ruleCatPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1 },
  ruleCatText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1 },
  cycleText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
});
