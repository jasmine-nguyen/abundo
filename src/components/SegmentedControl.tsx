import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT, tint, PRESSED } from '../theme';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

// WHIT-397: the app's pill-shaped segmented switch (This cycle / Last cycle, Spending / Earning,
// All / Uncategorised).
// One control, every toggle — the shared container/segment/text styling lives here; each segment's
// active tint + text colour are passed in per option, so a call site controls only what differs.
// Generic over the option value (a number for the cycle toggle, a string union for the side toggle).
export type SegmentedOption<T> = {
  value: T;
  label: string;
  testID: string;
  activeTint: string;       // background of the active segment
  activeTextColor: string;  // text colour of the active segment
  badge?: number;           // rose count bubble after the label (WHIT-846)
  flex?: number;            // relative width, default 1
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
            style={({ pressed }) => [styles.segment, { flex: option.flex ?? 1 }, active && { backgroundColor: option.activeTint }, pressed && PRESSED]}
          >
            <Text style={[styles.segmentText, active && { color: option.activeTextColor, fontWeight: '700' }]}>{option.label}</Text>
            {option.badge !== undefined && (
              <View style={styles.badge}>
                <Text style={styles.badgeText} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{option.badge}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', gap: 3, padding: 3, marginBottom: 16, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14 },
  segment: { flexDirection: 'row', gap: 6, minHeight: 44, paddingVertical: 9, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textDim },
  badge: { minWidth: 18, minHeight: 18, borderRadius: 999, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(C.bad, 0.2) },
  badgeText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: C.badBright },
});
