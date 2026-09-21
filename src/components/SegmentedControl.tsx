import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';

// WHIT-397: the app's pill-shaped segmented switch (This cycle / Last cycle, Spending / Earning).
// One control, both toggles — the shared container/segment/text styling lives here; each segment's
// active tint + text colour are passed in per option, so a call site controls only what differs.
// Generic over the option value (a number for the cycle toggle, a string union for the side toggle).
export type SegmentedOption<T> = {
  value: T;
  label: string;
  testID: string;
  activeTint: string;       // background of the active segment
  activeTextColor: string;  // text colour of the active segment
};

export function SegmentedControl<T extends string | number>({ options, value, onChange }: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.container}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <Pressable
            key={String(option.value)}
            testID={option.testID}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && { backgroundColor: option.activeTint }]}
          >
            <Text style={[styles.segmentText, active && { color: option.activeTextColor, fontWeight: '700' }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', gap: 3, padding: 3, marginBottom: 16, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14 },
  segment: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textDim },
});
