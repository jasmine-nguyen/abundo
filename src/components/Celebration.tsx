// WHIT-481 — the in-app confetti overlay for a goal milestone. Driven by `celebrationKey`: each
// increment (from useCheckpointCelebration) fires a fresh burst. Absolute-fill with
// pointerEvents="none" so it never blocks taps on the cards beneath, and it honours the OS
// reduce-motion flag — skipping the confetti and showing the banner alone.
// WHIT-747: the banner sits on a card surface and names the milestone reached.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { C, FONT } from '../theme';
import { useReduceMotion } from '../motion/useReduceMotion';

const PIECE_COUNT = 16;
const FALL_MS = 1200;
const BANNER_MS = 2400; // how long the banner stays, with or without confetti
const PIECE_COLORS = [C.goodBright, C.purple, C.accentSoft, C.good];

interface CelebrationProps {
  celebrationKey: number;
  label?: string | null;
  onDone?: () => void;
}

export function Celebration({ celebrationKey, label, onDone }: CelebrationProps) {
  const reduceMotion = useReduceMotion();
  const fall = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (celebrationKey <= 0) return; // 0 is the initial "nothing celebrated yet" state
    setVisible(true);

    if (!reduceMotion) {
      fall.setValue(0);
      Animated.timing(fall, {
        toValue: 1,
        duration: FALL_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    }

    // A plain timeout owns the lifecycle (hide + onDone) so it's deterministic and works whether
    // or not the animation runs — the Animated.timing above is purely decorative.
    const timer = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, BANNER_MS);
    return () => clearTimeout(timer);
  }, [celebrationKey]);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="checkpoint-celebration">
      {!reduceMotion && Array.from({ length: PIECE_COUNT }).map((_, i) => {
        const translateY = fall.interpolate({ inputRange: [0, 1], outputRange: [-40, 640] });
        const opacity = fall.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });
        return (
          <Animated.View
            key={i}
            testID="celebration-piece"
            style={[
              styles.piece,
              {
                left: `${6 + (i / PIECE_COUNT) * 88}%`,
                backgroundColor: PIECE_COLORS[i % PIECE_COLORS.length],
                opacity,
                transform: [{ translateY }],
              },
            ]}
          />
        );
      })}
      <View style={styles.bannerWrap}>
        <View testID="checkpoint-celebration-banner" style={styles.banner}>
          <Text testID="checkpoint-celebration-label" style={styles.bannerText}>
            {label ?? 'Milestone reached'} 🎉
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  piece: { position: 'absolute', top: 0, width: 9, height: 14, borderRadius: 2 },
  bannerWrap: { position: 'absolute', top: '38%', left: 24, right: 24, alignItems: 'center' },
  banner: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18,
    paddingVertical: 14, paddingHorizontal: 20,
    shadowColor: C.celebrationShadow, shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  bannerText: { fontFamily: FONT.display, fontSize: 18, fontWeight: '800', color: C.textBright, letterSpacing: -0.3, textAlign: 'center' },
});
