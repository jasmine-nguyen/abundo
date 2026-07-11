import React from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, ScrollView } from 'react-native';
import { C, FONT, tint } from '../theme';
import { Icon, ICON_KEYS } from '../icons';
import { BUCKETS, BUCKET_COLOR, Bucket, Category, eligibleParents } from '../context';

// WHIT-239: the ONE implementation of the category field controls (name / bucket / parent /
// icon), shared by the compact QuickCreateCategory form and the full category-edit screen.
//
// It is deliberately CONTROLLED and EFFECT-FREE: every value is owned by the host and passed
// in, and every tap is reported back via an onXChange callback. All the stateful behaviour —
// the cold-seed re-seed and parent-clear effects on the edit screen, the bucket-change
// parent-drop on QuickCreate, and the WHIT-244 attach-refilter loop guard — stays in the
// hosts. This component holds no useState/useEffect, so it cannot reintroduce any of them.
//
// It renders a FRAGMENT (no wrapping View) so each host's own container keeps governing the
// layout: QuickCreate's `wrap` (gap:10) and the edit screen's ScrollView spacing are both
// preserved exactly. The two surfaces differ only cosmetically — carried by `variant`.
export type CategoryFieldsVariant = 'compact' | 'screen';

export function CategoryFields({
  variant,
  name,
  onNameChange,
  namePlaceholder,
  autoFocusName = false,
  bucket,
  onBucketChange,
  lockBucket = false,
  icon,
  onIconChange,
  parent,
  onParentChange,
  parentPicker = false,
  categories,
  editId,
  noneLabel,
}: {
  variant: CategoryFieldsVariant;
  name: string;
  onNameChange: (s: string) => void;
  namePlaceholder: string;
  autoFocusName?: boolean;
  bucket: Bucket;
  onBucketChange: (b: Bucket) => void;
  lockBucket?: boolean;
  icon: string;
  onIconChange: (k: string) => void;
  parent: string | null;
  onParentChange: (id: string | null) => void;
  parentPicker?: boolean;
  categories: Category[];
  // Feeds the parent eligibility filter: null when creating (QuickCreate), the category's own
  // id when editing (so it can't be offered as its own parent). Same set the host effects use.
  editId: string | null;
  noneLabel: string;
}) {
  const s = variant === 'screen' ? screenStyles : compactStyles;
  // The screen surface labels the name + bucket rows; the compact form leaves them unlabelled.
  // Fully determined by `variant`, so it's derived here rather than taken as a separate prop.
  // (The PARENT and ICON labels show on BOTH surfaces, so they are always rendered.)
  const showLabels = variant === 'screen';
  // Unselected chip fill and icon glyph size are the only per-surface values that aren't part
  // of a StyleSheet (a color prop / a component prop), so they're picked here, not via `s`.
  const unselectedBg = variant === 'screen' ? C.card : C.cardAlt;
  const iconSize = variant === 'screen' ? 22 : 20;

  const parentOptions = parentPicker ? eligibleParents(categories, editId, bucket) : [];

  const iconButtons = ICON_KEYS.map((k) => {
    const sel = icon === k;
    return (
      <Pressable
        key={k}
        testID={`icon-${k}`}
        onPress={() => onIconChange(k)}
        style={[s.iconBtn, { borderColor: sel ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: sel ? 'rgba(124,140,255,.14)' : unselectedBg }]}
      >
        <Icon name={k} size={iconSize} color={sel ? C.accentSofter : C.textMid} />
      </Pressable>
    );
  });

  return (
    <>
      {showLabels && <Text style={s.label}>CATEGORY NAME</Text>}
      <TextInput
        value={name}
        onChangeText={onNameChange}
        placeholder={namePlaceholder}
        placeholderTextColor={C.placeholder}
        style={s.input}
        autoFocus={autoFocusName}
      />

      {!lockBucket && (
        <>
          {showLabels && <Text style={s.label}>BUCKET</Text>}
          <View style={s.row}>
            {BUCKETS.map((bk) => {
              const sel = bucket === bk;
              const col = BUCKET_COLOR[bk];
              return (
                <Pressable
                  key={bk}
                  onPress={() => onBucketChange(bk)}
                  style={[s.chip, { borderColor: sel ? col : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(col, 0.14) : unselectedBg }]}
                >
                  <Text style={[s.chipText, { color: sel ? col : C.textMid }]}>{bk}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {parentPicker && parentOptions.length > 0 && (
        <>
          <Text style={s.label}>PARENT (OPTIONAL)</Text>
          <View style={s.row}>
            <Pressable
              onPress={() => onParentChange(null)}
              style={[s.chip, { borderColor: parent === null ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: parent === null ? 'rgba(124,140,255,.14)' : unselectedBg }]}
            >
              <Text style={[s.chipText, { color: parent === null ? C.accentSofter : C.textMid }]}>{noneLabel}</Text>
            </Pressable>
            {parentOptions.map((p) => {
              const sel = parent === p.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => onParentChange(p.id)}
                  style={[s.chip, { borderColor: sel ? p.color : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(p.color, 0.14) : unselectedBg }]}
                >
                  <Text style={[s.chipText, { color: sel ? p.color : C.textMid }]} numberOfLines={1}>{p.name}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <Text style={s.label}>ICON</Text>
      {variant === 'screen' ? (
        <View style={s.iconContainer}>{iconButtons}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.iconContainer}>
          {iconButtons}
        </ScrollView>
      )}
    </>
  );
}

// Compact form (categorise sheet + edit screen's "new sub-category" inline). Values copied
// verbatim from the former QuickCreateCategory styles.
const compactStyles = StyleSheet.create({
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 11, borderRadius: 12, borderWidth: 1 },
  chipText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600' },
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 4, marginBottom: 2 },
  iconContainer: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  iconBtn: { width: 46, height: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});

// Full edit screen. Values copied verbatim from the former app/category/edit.tsx styles.
const screenStyles = StyleSheet.create({
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 15, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 13, borderRadius: 13, borderWidth: 1 },
  chipText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 2 },
  iconContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconBtn: { width: 52, height: 52, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
