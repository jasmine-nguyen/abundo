// Shared native date picker (WHIT-255). The loan + goal forms and the pay-cycle +
// goal-balance sheets all drove a @react-native-community/datetimepicker with the same
// load-bearing quirk — Android fires onChange for BOTH a pick and a dismiss, and the Date
// is the SECOND arg — copy-pasted four times and already drifting. This centralises that
// logic so a fix lands everywhere.
//
// Two exports:
//  - useNativeDate: the headless quirk logic (pick-vs-dismiss + arg extraction). The two
//    sheets keep their own card chrome and just call this.
//  - NativeDateField: a styled inline field row for the two forms (they share row chrome).
// Both preserve every call-site's behaviour and look exactly.
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { C, FONT } from '../theme';
import { parseISODate, toISODate, formatDayMonthYear } from '../dateutil';

// The picker's onChange fires (event, date) — the Date is the SECOND arg. Pull it from
// whichever position it lands in rather than assume arg 0 (assuming arg 0 crashed once:
// `event.getMonth()` is undefined). Android fires on BOTH a pick and a dismiss, so close
// the dialog either way and commit only when a Date actually came through.
export function useNativeDate(onPick: (iso: string) => void) {
  const [showPicker, setShowPicker] = useState(false);
  const isIOS = Platform.OS === 'ios';
  const commit = (a?: unknown, b?: unknown) => {
    setShowPicker(false);
    const picked = a instanceof Date ? a : b instanceof Date ? b : undefined;
    if (picked) onPick(toISODate(picked));
  };
  return { isIOS, showPicker, openPicker: () => setShowPicker(true), commit };
}

export interface NativeDateFieldProps {
  value: string | null;                      // ISO YYYY-MM-DD, or null when unset
  onChange: (iso: string | null) => void;    // null only via the Clear affordance
  minimumDate?: Date;
  maximumDate?: Date;
  placeholder?: string;                      // shown when unset (defaults to "Not set")
  clearable?: boolean;                       // render a "Clear" affordance once a value is set
  alwaysShowPillIOS?: boolean;               // iOS: show the pill always (loan) vs only while picking (everywhere else)
}

// The inline field row: the current value (or placeholder), an optional Clear, and the
// iOS compact pill / Android "Set date" affordance. Callers own their own label, outer
// margin, and hint — this owns only the row + the Android below-row dialog.
export function NativeDateField({
  value, onChange, minimumDate, maximumDate, placeholder, clearable, alwaysShowPillIOS,
}: NativeDateFieldProps) {
  const { isIOS, showPicker, openPicker, commit } = useNativeDate((iso) => onChange(iso));
  // iOS shows the compact pill inline. Loan shows it always (alwaysShowPillIOS). Everywhere else
  // the pill appears ONLY while actively picking: once a value is set we show it as the row text
  // with a "Change" affordance, so the same date isn't printed twice (the row text AND the pill
  // both showed it before). An unset field still shows "Set date", never a pre-filled pill that
  // reads as already-set.
  const showInlinePill = alwaysShowPillIOS ? isIOS : isIOS && showPicker;
  const pickerValue = value ? parseISODate(value) : (minimumDate ?? new Date());

  return (
    <>
      <View style={styles.inputRow}>
        <Text style={[styles.rowInput, !value && { color: C.placeholder }]}>
          {value ? formatDayMonthYear(value) : (placeholder ?? 'Not set')}
        </Text>
        {clearable && value ? (
          <Pressable onPress={() => onChange(null)} accessibilityRole="button">
            <Text style={styles.affordance}>Clear</Text>
          </Pressable>
        ) : null}
        {showInlinePill ? (
          <DateTimePicker
            value={pickerValue}
            mode="date"
            display="compact"
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            themeVariant="dark"
            accentColor={C.accent}
            onChange={commit}
          />
        ) : (
          <Pressable testID="date-open" onPress={openPicker} accessibilityRole="button">
            <Text style={styles.affordance}>{value ? 'Change' : 'Set date'}</Text>
          </Pressable>
        )}
      </View>
      {!isIOS && showPicker && (
        <DateTimePicker
          value={pickerValue}
          mode="date"
          display="default"
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={commit}
        />
      )}
    </>
  );
}

// Copied verbatim from the (byte-identical) row styles the two forms shared.
const styles = StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  // No forced height here: the row is alignItems:'center', so a natural-height single-line Text
  // sits vertically centred. (A copied-over height:'100%' + Android-only textAlignVertical left
  // the date text top-aligned on iOS.)
  rowInput: { flex: 1, fontFamily: FONT.body, fontSize: 16, color: C.text },
  affordance: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.accent, paddingHorizontal: 4 },
});
