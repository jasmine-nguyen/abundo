// Card 609 — the floating "Ask" pill that opens the Ask Abundo chat. Rendered by the tab bar, so
// it shows on all five tabs and never on pushed screens. It is NOT part of the bar's scroll-to-hide
// slide: the spec keeps it visible while scrolling.
import React from 'react';
import { Pressable, StyleSheet, Text, StyleProp, ViewStyle } from 'react-native';
import { C, FONT } from '../theme';
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
      style={({ pressed }) => [styles.pill, style, pressed && styles.pressed]}
    >
      {/* 24 = the pill's 25 radius minus its 1px ring; the fill clips, the pill doesn't (keeps the shadow). */}
      <GradientFill id="askGradient" x2={1} y2={1} stops={[[0, C.accent], [1, C.purple]]} borderRadius={24} />
      <Glyph name="chatSparkle" size={22} color={C.accentInk} />
      <Text style={styles.label}>Ask</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute', height: 50, borderRadius: 25, paddingLeft: 16, paddingRight: 20,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: C.askRing,
    shadowColor: C.askShadow, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  label: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
});
