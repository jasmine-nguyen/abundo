import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { C, FONT, fmt } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { useAppContext, goalView, milestoneView, lastRepaymentView } from '../../src/context';
import { Bar } from '../../src/components/ui';

export default function Goals() {
  const s = useAppContext();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const g = goalView(s);
  const m = milestoneView(s);
  const lr = lastRepaymentView(s);
  const G = g.G;

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.headerTitle}>Goal</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* hero — real payoff progress once loan facts are set, else a set-up prompt
            that still shows the one thing we genuinely know: the live balance. */}
        <View style={styles.hero}>
          <View style={styles.heroBlob} />
          {g.factsReady && g.balanceKnown ? (
            <>
              <Text style={styles.heroEyebrow}>THE MORTGAGE · WHITTLED SO FAR</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 7 }}>
                <Text style={styles.heroBig}>{fmt(g.paidOff!)}</Text>
                <Text style={styles.heroPct}>{Math.round(g.paidPct)}% gone</Text>
              </View>
              <View style={{ marginTop: 16 }}>
                <Bar pct={g.paidPct} color={C.goodBright} track="rgba(21,18,58,.18)" height={12} />
              </View>
              <View style={styles.heroRow}>
                <Text style={styles.heroRowL}>{g.balanceLabel} to go</Text>
                <Text style={styles.heroRowR}>started at {fmt(g.original!)}</Text>
              </View>
            </>
          ) : !g.factsReady ? (
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]}>{g.balanceLabel}</Text>
              <Text style={styles.heroSetupBody}>
                Add your loan amount and repayments to see how much you've whittled and your real payoff progress.
              </Text>
              <Pressable onPress={() => router.push('/loan')} style={styles.heroSetupBtn}>
                <Text style={styles.heroSetupBtnText}>Set up loan details →</Text>
              </Pressable>
            </>
          ) : (
            // Facts are set, but the live balance hasn't loaded yet — don't imply
            // "set up needed"; just wait on the balance.
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]}>{g.balanceLabel}</Text>
              <Text style={styles.heroSetupBody}>We'll show your whittled-so-far progress once your balance loads.</Text>
            </>
          )}
        </View>

        {/* freedom + interest — payoff projections (Cards 2/3). Shown once the loan
            is set up; still seed until those cards compute them for real. */}
        {g.factsReady && (
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            <View style={styles.miniCard}>
              <View style={styles.miniHead}><Glyph name="check" size={15} color={C.accentSoft} /><Text style={styles.miniLabel}>Mortgage-free</Text></View>
              <Text style={styles.miniValue}>{G.freedomDate}</Text>
              <Text style={[styles.miniSub, { color: C.good }]}>{G.aheadLabel} early 🏁</Text>
            </View>
            <View style={styles.miniCard}>
              <View style={styles.miniHead}><Glyph name="dollar" size={15} color={C.accentSoft} /><Text style={styles.miniLabel}>Interest dodged</Text></View>
              <Text style={styles.miniValue}>{fmt(G.interestSaved)}</Text>
              <Text style={styles.miniSub}>never going to the bank</Text>
            </View>
          </View>
        )}

        {/* 36-month milestone plan — real Sprint progress, taps into the full screen */}
        <Pressable testID="milestone-link" onPress={() => router.push('/milestone')} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>
              {m.hasBalance ? `${m.clearedCount} of ${m.total} sprints reached` : 'The 36-month plan'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.cardHint}>Sprint plan</Text>
              <Glyph name="chevron" size={15} color={C.textFaint} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 5 }}>
            {m.rows.map((r) => (
              <View key={r.sprint} style={{ flex: 1, height: 9, borderRadius: 3, backgroundColor: r.cleared ? C.good : 'rgba(255,255,255,.12)' }} />
            ))}
          </View>
          <View style={[styles.cardHead, { marginTop: 12, marginBottom: 0 }]}>
            {m.hasBalance ? (
              m.nextMilestone ? (
                <>
                  <Text style={[styles.cardTitle, { color: C.accentSofter, fontSize: 12.5 }]}>Next: under {fmt(m.nextMilestone.targetBalance)}</Text>
                  <Text style={styles.cardHint}>{m.amountToNextLabel} to go</Text>
                </>
              ) : (
                <Text style={[styles.cardTitle, { color: C.good, fontSize: 12.5 }]}>Target reached 🎉</Text>
              )
            ) : (
              <Text style={[styles.cardTitle, { color: C.accentSofter, fontSize: 12.5 }]}>Tap to see your live progress</Text>
            )}
          </View>
          {m.schedule && !m.schedule.onTrack && (
            <Text style={[styles.planSchedule, { color: m.schedule.ahead ? C.good : C.warn }]}>{m.schedule.label}</Text>
          )}
        </Pressable>

        {/* contribution — from the user's saved scheduled + extra repayment */}
        {g.factsReady && (
          <View style={styles.contribCard}>
            <Text style={styles.contribEyebrow}>HEADING TO THE LOAN THIS CYCLE</Text>
            <Text style={styles.contribBig}>{fmt(g.contribution!)}</Text>
            <Text style={styles.contribBody}>
              {fmt(g.baseRepay!)} scheduled <Text style={styles.contribStrong}>+ {fmt(g.extra!)} extra</Text>. Every coffee you skipped is a brick out of the wall. 🧱
            </Text>
          </View>
        )}

        {/* last repayment — the real most-recent home-loan repayment (WHIT-115),
            or a graceful empty state. Independent of the loan-facts form. */}
        <View style={styles.card}>
          {lr.present ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.repayChip}><Glyph name="arrowDown" size={22} color={C.good} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.repayTitle}>Last repayment · {lr.whenLabel}</Text>
                <Text style={styles.repaySub}>{lr.splitLabel ?? 'toward your home loan'}</Text>
              </View>
              <Text style={styles.repayAmount}>{lr.amountLabel}</Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.repayChip, { backgroundColor: 'rgba(255,255,255,.06)' }]}><Glyph name="arrowDown" size={22} color={C.textFaint} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.repayTitle}>Last repayment</Text>
                <Text style={styles.repaySub}>No repayment on record yet — it'll show here when one lands.</Text>
              </View>
            </View>
          )}
          <Pressable onPress={s.fireRepayment} style={styles.repayBtn}>
            <Glyph name="play" size={18} color={C.accentInk} />
            <Text style={styles.repayBtnText}>Preview a repayment alert</Text>
          </Pressable>
        </View>

        {/* investment property unlock — real usable equity once the property value
            is set, else a friendly prompt to add it. */}
        <View style={[styles.card, { marginBottom: 6 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13 }}>
            <View style={styles.ipChip}><Glyph name="building" size={22} color={C.purple} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.repayTitle}>Investment property #2</Text>
              <Text style={styles.repaySub}>Usable equity toward a deposit</Text>
            </View>
            {g.usableEquity != null && <View style={styles.ipPct}><Text style={styles.ipPctText}>{Math.round(g.depositPct)}%</Text></View>}
          </View>
          {g.usableEquity != null ? (
            <>
              <Bar pct={g.depositPct} color={C.purple} height={10} />
              <View style={[styles.cardHead, { marginTop: 9, marginBottom: 0 }]}>
                <Text style={[styles.cardTitle, { color: '#d9c9f7', fontSize: 12.5 }]}>{fmt(g.usableEquity)} unlocked</Text>
                <Text style={styles.cardHint}>of {fmt(g.depositTarget)} needed</Text>
              </View>
              <Text style={styles.ipBody}>Keep whittling — the more principal you kill, the more equity you can borrow against. Landlord arc loading. 📈</Text>
            </>
          ) : g.factsReady ? (
            // Property value is set; the equity figure just needs the live balance.
            <Text style={styles.ipBody}>Your usable equity will show once your balance loads.</Text>
          ) : (
            <>
              <Text style={styles.ipBody}>Add your property value to see how much equity you could unlock toward your next place.</Text>
              <Pressable onPress={() => router.push('/loan')} style={styles.equityCta}>
                <Text style={styles.equityCtaText}>Add loan details →</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12 },
  headerTitle: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: '#fff', letterSpacing: -0.2 },

  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 22, paddingBottom: 20, marginBottom: 14, backgroundColor: '#6470de' },
  heroBlob: { position: 'absolute', right: -26, top: -26, width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(255,255,255,.1)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: 'rgba(20,18,50,.62)', letterSpacing: 0.3 },
  heroBig: { fontFamily: FONT.display, fontSize: 48, fontWeight: '800', color: C.heroInk, lineHeight: 48, letterSpacing: -2 },
  heroPct: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.heroInk2 },
  heroRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 9 },
  heroRowL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.heroInk2 },
  heroRowR: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: 'rgba(20,18,50,.6)' },
  heroSetupBody: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.heroInk2, lineHeight: 20, marginTop: 10 },
  heroSetupBtn: { alignSelf: 'flex-start', backgroundColor: 'rgba(21,18,58,.18)', borderRadius: 11, paddingVertical: 9, paddingHorizontal: 14, marginTop: 14 },
  heroSetupBtnText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.heroInk },
  equityCta: { alignSelf: 'flex-start', backgroundColor: 'rgba(201,179,245,.16)', borderRadius: 11, paddingVertical: 9, paddingHorizontal: 14, marginTop: 12 },
  equityCtaText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.purple },

  miniCard: { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 14 },
  miniHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniLabel: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.accentSoft },
  miniValue: { fontFamily: FONT.display, fontSize: 20, fontWeight: '800', color: C.text, marginTop: 5, letterSpacing: -0.4 },
  miniSub: { fontFamily: FONT.body, fontSize: 11.5, color: C.textDim, fontWeight: '600', marginTop: 2 },

  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardTitle: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.textBright },
  cardHint: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },

  planSchedule: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', marginTop: 8 },

  contribCard: { backgroundColor: 'rgba(124,140,255,.1)', borderWidth: 1, borderColor: 'rgba(124,140,255,.22)', borderRadius: 18, padding: 16, marginBottom: 12 },
  contribEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSofter },
  contribBig: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: '#fff', letterSpacing: -1, marginTop: 4 },
  contribBody: { fontFamily: FONT.body, fontSize: 13, color: '#a6a6b0', lineHeight: 19, marginTop: 6 },
  contribStrong: { color: '#e6e6ea', fontWeight: '700' },

  repayChip: { width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(53,217,160,.14)', alignItems: 'center', justifyContent: 'center' },
  repayTitle: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.textBright },
  repaySub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  repayAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '800', color: C.good },
  repayBtn: { marginTop: 14, paddingVertical: 13, borderRadius: 14, backgroundColor: C.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  repayBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentInk },

  ipChip: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(201,179,245,.16)', alignItems: 'center', justifyContent: 'center' },
  ipPct: { backgroundColor: 'rgba(201,179,245,.14)', paddingVertical: 3, paddingHorizontal: 9, borderRadius: 8 },
  ipPctText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: C.purple },
  ipBody: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, lineHeight: 18, marginTop: 11 },
});
