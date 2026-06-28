import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, BUCKETS, BUCKET_COLOR, Bucket } from '../../src/context';
import { ICON_KEYS } from '../../src/icons';
import { Header } from '../../src/components/Header';

export default function CategoryEdit() {
  const s = useAppContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { catId } = useLocalSearchParams<{ catId?: string }>();
  const existing = catId ? s.cat(catId) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [bucket, setBucket] = useState<Bucket>(existing?.bucket ?? 'Lifestyle');
  const [icon, setIcon] = useState(existing?.icon ?? 'coffee');

  const color = existing?.color ?? C.accent;
  const canSave = name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    s.saveCat(catId ?? null, { name, bucket, icon });
    router.back();
  };
  const remove = () => {
    if (!catId) return;
    s.deleteCat(catId);
    router.back();
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={catId ? 'Edit category' : 'New category'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.preview}>
          <View style={[styles.previewChip, { backgroundColor: tint(color, 0.15) }]}><Icon name={icon} size={34} color={color} /></View>
        </View>

        <Text style={styles.fieldLabel}>CATEGORY NAME</Text>
        <TextInput value={name} onChangeText={setName} placeholder="e.g. Coffee runs" placeholderTextColor={C.placeholder} style={styles.input} />

        <Text style={styles.fieldLabel}>BUCKET</Text>
        <View style={styles.bucketRow}>
          {BUCKETS.map((bk) => {
            const sel = bucket === bk;
            const col = BUCKET_COLOR[bk];
            return (
              <Pressable key={bk} onPress={() => setBucket(bk)} style={[styles.bucketBtn, { borderColor: sel ? col : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(col, 0.14) : C.card }]}>
                <Text style={[styles.bucketText, { color: sel ? col : C.textMid }]}>{bk}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>ICON</Text>
        <View style={styles.iconGrid}>
          {ICON_KEYS.map((k) => {
            const sel = icon === k;
            return (
              <Pressable key={k} onPress={() => setIcon(k)} style={[styles.iconBtn, { borderColor: sel ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: sel ? 'rgba(124,140,255,.14)' : C.card }]}>
                <Icon name={k} size={22} color={sel ? C.accentSofter : C.textMid} />
              </Pressable>
            );
          })}
        </View>

        {catId && (
          <Pressable onPress={remove} style={styles.deleteBtn}>
            <Text style={styles.deleteText}>Delete category</Text>
          </Pressable>
        )}
        <Pressable onPress={save} style={[styles.saveBtn, { backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}>
          <Text style={[styles.saveText, { color: canSave ? C.accentInk : '#6a6a90' }]}>Save category</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { alignItems: 'center', paddingVertical: 14 },
  previewChip: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 2 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 15, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bucketBtn: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 13, borderRadius: 13, borderWidth: 1 },
  bucketText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconBtn: { width: 52, height: 52, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { marginTop: 24, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  deleteText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
  saveBtn: { marginTop: 12, paddingVertical: 16, borderRadius: 15, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
});
