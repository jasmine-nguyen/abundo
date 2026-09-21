import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, fmt } from '../theme';
import { Bar } from './ui';

// WHIT-372: the mortgage "paid down so far" block, shared by the /mortgage hero and the Goals-hub
// card so the two can't drift (the "% gone" label already moved to goalView.paidPctLabel; this
// removes the last of the duplicated layout). Purely presentational — the screens decide WHETHER
// to render it (their paidDownReady gate); this only draws. The two variants keep each screen's
// deliberate sizing verbatim: the hero is bigger (48px figure, height-12 bar, longer eyebrow) than
// the card (30px figure, height-11 bar). Every style value below is copied 1:1 from the old
// inline/StyleSheet values on each screen, so the extraction is visually a no-op.
export function PayoffSummary({
  variant, paidOff, paidPctLabel, paidPct, balanceLabel, original,
}: {
  variant: 'hero' | 'card';
  paidOff: number;       // the big figure (dollars paid down)
  paidPctLabel: number;  // the clamped "{n}% gone" headline (from goalView)
  paidPct: number;       // the raw Bar fill (unclamped)
  balanceLabel: string;  // already-formatted "$X" balance still owing
  original: number;      // the "started at $Y" figure
}) {
  const hero = variant === 'hero';
  const s = hero ? heroStyles : cardStyles;
  return (
    <>
      <Text style={s.eyebrow}>{hero ? 'THE MORTGAGE · PAID DOWN SO FAR' : 'PAID DOWN SO FAR'}</Text>
      <View style={s.figureRow}>
        <Text style={s.big} numberOfLines={hero ? undefined : 1}>{fmt(paidOff)}</Text>
        <Text style={s.pct}>{paidPctLabel}% gone</Text>
      </View>
      <View style={s.barWrap}>
        <Bar pct={paidPct} color={C.goodBright} track="rgba(21,18,58,.18)" height={hero ? 12 : 11} />
      </View>
      <View style={s.foot}>
        <Text style={s.footL}>{balanceLabel} to go</Text>
        <Text style={s.footR}>started at {fmt(original)}</Text>
      </View>
    </>
  );
}

const heroStyles = StyleSheet.create({
  eyebrow: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: 'rgba(20,18,50,.62)', letterSpacing: 0.3 },
  figureRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 7 },
  big: { fontFamily: FONT.display, fontSize: 48, fontWeight: '800', color: C.heroInk, lineHeight: 48, letterSpacing: -2 },
  pct: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.heroInk2 },
  barWrap: { marginTop: 16 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 9 },
  footL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.heroInk2 },
  footR: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
});

const cardStyles = StyleSheet.create({
  eyebrow: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: 'rgba(20,18,50,.62)', letterSpacing: 0.3, marginTop: 15 },
  figureRow: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 6 },
  big: { flexShrink: 1, fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.heroInk, letterSpacing: -1 },
  pct: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.heroInk2 },
  barWrap: { marginTop: 12 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  footL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.heroInk2 },
  footR: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
});
