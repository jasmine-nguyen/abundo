import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { transactionView, useAppContext, Transaction } from '../../src/context';
import { formatDayMonthYear } from '../../src/dateutil';
import { useTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { Icon, Glyph } from '../../src/icons';
import { DetailStates } from '../../src/components/DetailStates';

// WHIT-272 / WHIT-275: the per-transaction detail screen. Reached by the trailing chevron on
// a TransactionRow; the id in the route is the transaction_id. The transaction comes from the
// SAME cached query the lists use (no new endpoint) — we find it by id. Shows the read-only
// fields (WHIT-272) plus an editable note + tags (WHIT-275) that save optimistically and roll
// back on failure via applyTransactionEdit.
// Server caps (mirrored here as input limits for good UX; the server is the real gate).
// TAG_MAX_COUNT must match TAG_MAX_COUNT in lambda_api/handler.py — no shared constant
// spans the TS/Python boundary, so if the server cap moves, move this too.
const NOTE_MAX_LEN = 500;
const TAG_MAX_LEN = 50;
const TAG_MAX_COUNT = 20;

export default function TransactionDetail() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { openPicker } = useAppContext();
  const { transactions, category, isLoading, isError, refetch } = useTransactionsScreenData();
  const transaction = transactions.find((t) => t.transaction_id === id);
  const view = transaction ? transactionView({ category }, transaction) : null;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Transaction" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // The NOTE + TAGS fields sit at the bottom of the screen, so the keyboard opens
        // right over them and you can't see what you're typing. This insets the scroll
        // content by the keyboard height and scrolls the focused field into view (iOS).
        automaticallyAdjustKeyboardInsets
      >
        <DetailStates
          isLoading={isLoading}
          isError={isError}
          hasCache={transactions.length > 0}
          idPrefix="transaction"
          errorText="Couldn't load this transaction."
          retryLabel="Retry loading this transaction"
          onRetry={refetch}
        >
          {transaction && view ? (
            <>
              <View style={styles.hero}>
                <View style={[styles.chip, { backgroundColor: view.chipBg }]}>
                  <Icon name={view.icon} size={30} color={view.iconColor} />
                </View>
                <Text style={styles.merchant} numberOfLines={2}>{view.merchant}</Text>
                <Text style={[styles.amount, { color: view.amountColor }]}>{view.amountLabel}</Text>
              </View>

              <View style={styles.card}>
                <Field label="Date" value={formatDayMonthYear(transaction.date)} />
                <Field label="Account" value={transaction.account_name} />
                {/* WHIT-287: the Category row is tappable — it re-opens the SAME categorize
                    picker the lists use (openPicker → PickerSheet → ConfirmSheet), so any
                    transaction can be re-filed, not just the Uncategorized ones a list row
                    offers. `refileOnly` scopes the confirm step to THIS charge (no merchant-wide
                    rule). The chevron marks it as the one editable field in this card. */}
                <Field
                  label="Category"
                  value={view.categoryLabel}
                  valueColor={view.categoryColor}
                  onPress={() => openPicker(transaction.transaction_id, { refileOnly: true })}
                  actionLabel={`Change category, currently ${view.categoryLabel}`}
                />
                <Field label="Status" value={view.isPending ? 'Pending' : 'Posted'} last />
              </View>

              {/* Keyed by id so switching transactions reseeds the local note text. */}
              <NoteAndTagsEditor key={transaction.transaction_id} transaction={transaction} />
            </>
          ) : (
            // No transaction carries this id (stale/unknown link) — settled, not loading.
            <View style={styles.empty}>
              <Glyph name="search" size={26} color={C.textFaint} />
              <Text style={styles.emptyTitle}>Transaction not found</Text>
              <Text style={styles.emptySub}>This transaction is no longer in your recent list.</Text>
            </View>
          )}
        </DetailStates>
      </ScrollView>
    </View>
  );
}

// The editable half (WHIT-275). Rendered only when the transaction exists, keyed by its id,
// so local note state seeds cleanly from the loaded row. Tags are derived straight from the
// cache (the single source of truth) — every add/remove goes through applyTransactionEdit,
// which patches the cache optimistically, so the chips reflect the change immediately.
function NoteAndTagsEditor({ transaction }: { transaction: Transaction }) {
  const { applyTransactionEdit, showToast } = useAppContext();
  const txId = transaction.transaction_id;
  const savedNote = transaction.notes ?? '';
  const tags = transaction.tags ?? [];
  const [noteText, setNoteText] = useState(savedNote);
  const [tagInput, setTagInput] = useState('');

  // Track the latest text (for the unmount flush) and the last value we actually persisted,
  // so a blur immediately followed by unmount (the "edit note → tap back" path) saves ONCE,
  // not twice: onBlur fires commitNote, then the effect cleanup fires it again before the
  // cache-driven re-render has re-derived savedNote. lastSavedNote short-circuits that.
  const noteTextRef = useRef(noteText);
  noteTextRef.current = noteText;
  const lastSavedNote = useRef(savedNote);

  const commitNote = useCallback(() => {
    const trimmed = noteTextRef.current.trim();
    if (trimmed === lastSavedNote.current) return;
    lastSavedNote.current = trimmed;
    applyTransactionEdit(txId, { notes: trimmed });
  }, [applyTransactionEdit, txId]);

  // Flush an unsaved note edit if the user navigates away without blurring the field first.
  useEffect(() => commitNote, [commitNote]);

  const commitTag = (candidate: string) => {
    const trimmed = candidate.trim();
    setTagInput('');
    if (!trimmed) return;
    // Dedupe case-insensitively, keeping the existing tags' original casing.
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
    // Refuse a new tag at the cap with a friendly nudge, rather than adding it
    // optimistically only for the server to 400 it and roll back (WHIT-280). Dedupe
    // runs first, so re-typing an existing tag at the cap stays a silent no-op. The
    // server is still the real gate; two adds in one tick could both pass this check.
    if (tags.length >= TAG_MAX_COUNT) {
      showToast(`Up to ${TAG_MAX_COUNT} tags.`);
      return;
    }
    applyTransactionEdit(txId, { tags: [...tags, trimmed] });
  };

  const onTagChange = (text: string) => {
    // A trailing comma commits the tag (alongside the keyboard's return key).
    if (text.endsWith(',')) commitTag(text.slice(0, -1));
    else setTagInput(text);
  };

  const removeTag = (tag: string) => {
    applyTransactionEdit(txId, { tags: tags.filter((t) => t !== tag) });
  };

  return (
    <>
      <Text style={styles.sectionLabel}>NOTE</Text>
      <TextInput
        testID="note-input"
        accessibilityLabel="Note"
        style={styles.noteInput}
        value={noteText}
        onChangeText={setNoteText}
        onBlur={commitNote}
        placeholder="What was this for?"
        placeholderTextColor={C.placeholder}
        multiline
        maxLength={NOTE_MAX_LEN}
      />

      <Text style={styles.sectionLabel}>TAGS</Text>
      <View style={styles.tagsWrap}>
        {tags.map((tag) => (
          <View key={tag} style={styles.tagChip}>
            <Text style={styles.tagText}>{tag}</Text>
            <Pressable
              onPress={() => removeTag(tag)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${tag}`}
            >
              <Text style={styles.tagRemove}>×</Text>
            </Pressable>
          </View>
        ))}
      </View>
      <TextInput
        testID="tag-input"
        accessibilityLabel="Add a tag"
        style={styles.tagInput}
        value={tagInput}
        onChangeText={onTagChange}
        onSubmitEditing={() => commitTag(tagInput)}
        placeholder="Add a tag"
        placeholderTextColor={C.placeholder}
        autoCapitalize="none"
        maxLength={TAG_MAX_LEN}
        returnKeyType="done"
      />
    </>
  );
}

// A label/value row inside the details card. When `onPress` is given the whole row
// becomes a button (with a trailing chevron + press dim) — that's how the Category
// row opens the re-categorize picker (WHIT-287). Without it, the row is static.
function Field({ label, value, valueColor, last, onPress, actionLabel }: {
  label: string; value: string; valueColor?: string; last?: boolean;
  onPress?: () => void; actionLabel?: string;
}) {
  const inner = (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldValueWrap}>
        <Text style={[styles.fieldValue, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
        {onPress && <Glyph name="chevron" size={16} color={C.textFaint} />}
      </View>
    </>
  );
  if (!onPress) {
    return <View style={[styles.field, last && styles.fieldLast]}>{inner}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={actionLabel}
      style={({ pressed }) => [styles.field, last && styles.fieldLast, pressed && styles.fieldPressed]}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 22, gap: 10 },
  chip: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  merchant: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: C.textBright, letterSpacing: -0.4, textAlign: 'center' },
  amount: { fontFamily: FONT.display, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },

  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, paddingHorizontal: 16, marginTop: 6 },
  field: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.hairline },
  fieldLast: { borderBottomWidth: 0 },
  fieldPressed: { opacity: 0.6 },
  fieldLabel: { fontFamily: FONT.body, fontSize: 13.5, color: C.textMid },
  fieldValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, justifyContent: 'flex-end' },
  fieldValue: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.textBright, flexShrink: 1, textAlign: 'right' },

  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 22, marginBottom: 8, marginHorizontal: 4 },
  noteInput: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, padding: 14, minHeight: 88, fontFamily: FONT.body, fontSize: 14.5, color: C.textBright, textAlignVertical: 'top' },
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tagChip: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: C.cardAlt, borderWidth: 1, borderColor: C.hairlineStrong, borderRadius: 999, paddingVertical: 6, paddingLeft: 12, paddingRight: 9 },
  tagText: { fontFamily: FONT.body, fontSize: 13, color: C.textBright },
  tagRemove: { fontFamily: FONT.body, fontSize: 17, lineHeight: 18, color: C.textDim, fontWeight: '600' },
  tagInput: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, marginTop: 10, fontFamily: FONT.body, fontSize: 14, color: C.textBright },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30, gap: 8 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright, marginTop: 4 },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', lineHeight: 20 },
});
