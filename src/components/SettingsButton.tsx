import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, tint } from '../theme';
import { Glyph } from '../icons';

// WHIT-495: the header gear that replaces the Settings tab. Sits in the top-left header slot on
// every tab; pushes the /settings route (now a root screen). 40x40 visual + hitSlop to clear the
// 44x44 minimum touch target without scaling the ~20pt glyph.
export function SettingsButton() {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push('/settings')}
      hitSlop={8}
      style={styles.btn}
      accessibilityRole="button"
      accessibilityLabel="Settings"
    >
      <Glyph name="navSettings" size={20} color={C.accentSoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 40, height: 40, backgroundColor: tint(C.accentAlt, 0.16), borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
