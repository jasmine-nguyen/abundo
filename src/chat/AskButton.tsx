// Card 609 — the floating round Ask button that opens the Ask Abundo chat. Rendered by the tab bar,
// so it shows on all five tabs and never on pushed screens. It is NOT part of the bar's scroll-to-hide
// slide: the spec keeps it visible while scrolling. WHIT-704 — a 48pt circle, icon only.
import React from 'react';
import { Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { C } from '../theme';
import { GradientFill } from '../components/ui';
import { Glyph } from '../icons';
import { useChat } from './ChatContext';

export function AskButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { openChat } = useChat();
  return (
    <Pressable
      testID="ask-button"
      onPress={() => openChat()}
      accessibilityRole="button"
      accessibilityLabel="Ask about your spending"
      style={({ pressed }) => [styles.button, style, pressed && styles.pressed]}
    >
      {/* 23 = the button's 24 radius minus its 1px ring; the fill clips, the button doesn't (keeps the shadow). */}
      <GradientFill id="askGradient" x2={1} y2={1} stops={[[0, C.accent], [1, C.purple]]} borderRadius={23} />
      <Glyph name="chatSparkle" size={22} color={C.accentInk} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute', width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.askRing,
    shadowColor: C.askShadow, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
});
