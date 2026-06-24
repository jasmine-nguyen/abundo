import React from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { C, FONT } from '../theme';

// A pace progress bar: posted (solid) + pending (translucent) + target tick.
export function WhittleBar({
  postedPct, pendingPct, targetPct, postedColor, pendingTint, height = 10, showTarget = true,
}: {
  postedPct: number; pendingPct: number; targetPct: number;
  postedColor: string; pendingTint: string; height?: number; showTarget?: boolean;
}) {
  return (
    <View>
      <View style={[styles.track, { height, borderRadius: height * 0.6 }]}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${postedPct}%`, backgroundColor: postedColor, borderTopLeftRadius: height * 0.6, borderBottomLeftRadius: height * 0.6 }} />
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: `${postedPct}%`, width: `${pendingPct}%`, backgroundColor: pendingTint }} />
      </View>
      {showTarget && (
        <View style={{ position: 'relative', height: 18, marginTop: 1 }}>
          <View style={{ position: 'absolute', top: -13, bottom: 0, width: 2, backgroundColor: 'rgba(255,255,255,.85)', left: `${targetPct}%` }} />
        </View>
      )}
    </View>
  );
}

// Plain progress bar with a gradient-ish single fill colour.
export function Bar({ pct, color, track = 'rgba(255,255,255,.07)', height = 10 }: { pct: number; color: string; track?: string; height?: number }) {
  return (
    <View style={{ height, borderRadius: height * 0.6, backgroundColor: track, overflow: 'hidden' }}>
      <View style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: height * 0.6 }} />
    </View>
  );
}

export function Chip({ bg, color, size = 42, radius = 13, children }: { bg: string; color?: string; size?: number; radius?: number; children: React.ReactNode }) {
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
}

export function Card({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.sectionLabel, style]}>{children}</Text>;
}

export const T = StyleSheet.create({
  display: { fontFamily: FONT.display, color: C.text },
  body: { fontFamily: FONT.body, color: C.text },
});

const styles = StyleSheet.create({
  track: { position: 'relative', backgroundColor: 'rgba(255,255,255,.07)', overflow: 'hidden' },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18 },
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginHorizontal: 4, marginBottom: 8 },
});
