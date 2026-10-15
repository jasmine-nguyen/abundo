import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { C, FONT, PRESSED } from '../theme';

// The "Load More" button at the end of a paged list (the Transactions tab, budget detail, the
// account page). While the next page loads it swaps for a matched-height spinner (`${testID}-spinner`)
// so the list doesn't jump.
export function LoadMoreButton({ testID, onPress, loading, accessibilityLabel, style }: {
  testID: string;
  onPress: () => void;
  loading?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  if (loading) {
    return (
      <View testID={`${testID}-spinner`} style={[styles.loadingState, style]}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.button, style, pressed && PRESSED]}
    >
      <Text style={styles.text}>Load More</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { marginTop: 18, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderColor: C.hairline, alignItems: 'center' },
  text: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSoft },
  loadingState: { marginTop: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
});
