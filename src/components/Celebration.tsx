// WHIT-481 — the in-app confetti overlay for a checkpoint crossing. Driven by `celebrationKey`:
// each increment (from useCheckpointCelebration) fires a fresh burst. Absolute-fill with
// pointerEvents="none" so it never blocks taps on the cards beneath, and it honours the OS
// reduce-motion flag — skipping the animation for a brief plain banner instead.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { C, FONT } from '../theme';
import { useReduceMotion } from '../motion/useReduceMotion';

const PIECE_COUNT = 16;
const FALL_MS = 1200;
const REDUCED_MS = 900; // how long the plain banner shows when motion is off
const PIECE_COLORS = [C.goodBright, C.purple, C.accentSoft, C.good];

interface CelebrationProps {
  celebrationKey: number;
  label?: string | null;
  newlyReached?: number;
  onDone?: () => void;
}

export function Celebration({ celebrationKey, label, newlyReached = 1, onDone }: CelebrationProps) {
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
    }, reduceMotion ? REDUCED_MS : FALL_MS);
    return () => clearTimeout(timer);
  }, [celebrationKey]);

  if (!visible) return null;

  const title = label ? `${label}: checkpoint reached!` : 'Checkpoint reached!';

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="checkpoint-celebration">
      {!reduceMotion && Array.from({ length: PIECE_COUNT }).map((_, i) => {
        const translateY = fall.interpolate({ inputRange: [0, 1], outputRange: [-40, 640] });
        const opacity = fall.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });
        return (
          <Animated.View
            key={i}
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
        <Text testID="checkpoint-celebration-label" style={styles.banner}>{title} 🎉</Text>
        {newlyReached > 1 && <Text style={styles.sub}>{newlyReached} checkpoints!</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  piece: { position: 'absolute', top: 0, width: 9, height: 14, borderRadius: 2 },
  bannerWrap: { position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center' },
  banner: { fontFamily: FONT.display, fontSize: 20, fontWeight: '800', color: C.textBright, letterSpacing: -0.3 },
  sub: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSoft, marginTop: 4 },
});
