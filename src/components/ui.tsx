import React from 'react';
import { ActivityIndicator, View, Text, Pressable, StyleSheet, ViewStyle, TextStyle, StyleProp } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { C, FONT, tint } from '../theme';
import { Glyph } from '../icons';

// WHIT-615 — a full-bleed gradient layer. iOS react-native-svg saves a shape's `%` sizes from
// its first draw and never updates them on resize, so the Rect is sized in a 0-1 viewBox that
// is stretched to the current size on every draw. Corners come from the wrapper View, never `rx`.
// The Svg needs its absoluteFill style and no width/height: without them the library quietly
// falls back to width="100%".
export function GradientFill({ id, stops, x2, y2, borderRadius }: {
  id: string; stops: [offset: number, color: string][]; x2: number; y2: number; borderRadius?: number;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, { borderRadius, overflow: 'hidden' }]} pointerEvents="none">
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 1 1" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2={x2} y2={y2}>
            {stops.map(([offset, color]) => <Stop key={offset} offset={offset} stopColor={color} />)}
          </LinearGradient>
        </Defs>
        <Rect width={1} height={1} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

// Full-bleed 150° accent→purple gradient fill for hero cards (Tokyo Night). Renders as an
// absolutely-positioned layer, so drop it as the FIRST child of a position:relative,
// overflow:hidden hero card — it sits behind the decorative blobs and the content, which
// use C.heroInk / C.heroInk2 so they stay legible on the light-blue fill. Reads the
// heroGradFrom → heroGradMid → heroGradTo theme tokens.
export function HeroGradientFill() {
  return (
    <GradientFill
      id="heroGrad" x2={0.5} y2={1}
      stops={[[0, C.heroGradFrom], [0.55, C.heroGradMid], [1, C.heroGradTo]]}
    />
  );
}

// A Retry affordance for a failed-read error state. Owns the accessibility contract (button
// role + a screen-reader label) and the "Retry" label in ONE place, so the app's several
// error states — the Goal hero balance error, the Goal repayment error, and the milestone
// balance error — can't drift apart on a11y (WHIT-121). Styling is per-site (hero-ink on the
// light hero vs an accent chip on a dark card), so the caller passes the button + text styles;
// only the a11y contract and the visible "Retry" label are shared.
export function RetryButton({ onPress, label, testID, style, textStyle }: {
  onPress: () => void; label: string; testID: string;
  style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable onPress={onPress} style={style} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Text style={textStyle}>Retry</Text>
    </Pressable>
  );
}

// WHIT-702: a text button in the ScrollChromeHeader's top bar (Select / Cancel / Export).
export function HeaderTextButton({ label, onPress, testID, busy = false, accessibilityLabel }: {
  label: string; onPress: () => void; testID?: string; busy?: boolean; accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      hitSlop={8}
      style={styles.hdrBtn}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy }}
    >
      {busy ? <ActivityIndicator color={C.accentSoft} /> : <Text style={styles.hdrBtnText}>{label}</Text>}
    </Pressable>
  );
}

// A pace progress bar: posted (solid) + pending (translucent) + target tick.
export function BudgetBar({
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
          <View style={{ position: 'absolute', top: -13, bottom: 0, width: 2, backgroundColor: C.progressTick, left: `${targetPct}%` }} />
        </View>
      )}
    </View>
  );
}

// Plain progress bar with a gradient-ish single fill colour.
export function Bar({ pct, color, track = C.progressTrack, height = 10, markers }: { pct: number; color: string; track?: string; height?: number; markers?: { pct: number; reached: boolean }[] }) {
  const fill = (
    <View style={{ height, borderRadius: height * 0.6, backgroundColor: track, overflow: 'hidden' }}>
      <View style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: height * 0.6 }} />
    </View>
  );
  // No markers → the exact same single view as before, so every other Bar caller is unaffected.
  if (!markers?.length) return fill;

  // WHIT-486: checkpoint dots overlaid on the bar — filled = reached, hollow (card-coloured centre)
  // = not yet. The overlay is a sibling that doesn't clip, so a dot at 0%/100% can overhang the
  // rounded ends instead of being cut off by the track's overflow:hidden. `markers[].pct` is 0..1.
  const dot = height + 2;
  return (
    <View style={{ position: 'relative' }}>
      {fill}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: (height - dot) / 2, height: dot }}>
        {markers.map((m, i) => (
          <View
            key={i}
            testID={m.reached ? 'bar-dot-reached' : 'bar-dot'}
            style={{
              position: 'absolute', left: `${m.pct * 100}%`, marginLeft: -dot / 2,
              width: dot, height: dot, borderRadius: dot / 2,
              borderWidth: 2, borderColor: color,
              backgroundColor: m.reached ? color : C.card,
            }}
          />
        ))}
      </View>
    </View>
  );
}

export function SectionLabel({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.sectionLabel, style]}>{children}</Text>;
}

// WHIT-711: the tinted square icon button in a header (the "+" buttons, the Settings gear).
export function HeaderIconButton({ icon, onPress, accessibilityLabel, testID, iconSize = 22 }: {
  icon: string; onPress: () => void; accessibilityLabel: string; testID?: string; iconSize?: number;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      hitSlop={8}
      style={styles.hdrIconBtn}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Glyph name={icon} size={iconSize} color={C.accentSoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hdrIconBtn: { width: 40, height: 40, backgroundColor: tint(C.accentAlt, 0.16), borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  track: { position: 'relative', backgroundColor: C.progressTrack, overflow: 'hidden' },
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginHorizontal: 4, marginBottom: 8 },
  hdrBtn: { height: 40, paddingHorizontal: 8, alignItems: 'flex-end', justifyContent: 'center' },
  hdrBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentSoft },
});
