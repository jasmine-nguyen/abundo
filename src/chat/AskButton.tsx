// Card 609 — the floating round Ask button that opens the Ask Abundo chat. Rendered by the tab bar,
// so it shows on all five tabs and never on pushed screens. WHIT-730: the tab bar slides it away with
// the bar on scroll, so it doesn't cover row content mid-list. WHIT-704 — a 48pt circle, icon only.
import React from 'react';
import { Pressable, View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { C, PRESSED } from '../theme';
import { GradientFill } from '../components/ui';
import { Glyph } from '../icons';
import { SCREEN_PADDING } from '../motion/ScrollChromeHeader';
import { useChat } from './ChatContext';

export const ASK_BUTTON_SIZE = 48;
export const ASK_BUTTON_EDGE = 18;
const ASK_BUTTON_LANE = ASK_BUTTON_EDGE + ASK_BUTTON_SIZE;
// Lists stop the usual 12pt card gap short of the button's lane, so it never covers a row, even at rest.
export const ASK_BUTTON_RIGHT_CLEARANCE = ASK_BUTTON_LANE - SCREEN_PADDING + 12;

export function AskButtonClearance({ children }: { children: React.ReactNode }) {
  return <View testID="ask-button-clearance" style={styles.clearance}>{children}</View>;
}

export function AskButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { openChat } = useChat();
  return (
    <Pressable
      testID="ask-button"
      onPress={() => openChat()}
      accessibilityRole="button"
      accessibilityLabel="Ask about your spending"
      style={({ pressed }) => [styles.button, style, pressed && PRESSED]}
    >
      {/* 23 = the button's 24 radius minus its 1px ring; the fill clips, the button doesn't (keeps the shadow). */}
      <GradientFill id="askGradient" x2={1} y2={1} stops={[[0, C.accent], [1, C.purple]]} borderRadius={23} />
      <Glyph name="chatSparkle" size={22} color={C.accentInk} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute', width: ASK_BUTTON_SIZE, height: ASK_BUTTON_SIZE, borderRadius: ASK_BUTTON_SIZE / 2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.askRing,
    shadowColor: C.askShadow, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  clearance: { paddingRight: ASK_BUTTON_RIGHT_CLEARANCE },
});
