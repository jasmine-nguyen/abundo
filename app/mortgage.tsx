import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT, fmt, tint } from '../src/theme';
import { Glyph } from '../src/icons';
import { goalView, paydownView, milestoneView, lastRepaymentView } from '../src/context';
import { useGoalScreenData } from '../src/queries';
import { Bar, RetryButton, HeroGradientFill } from '../src/components/ui';
import { PayoffSummary } from '../src/components/PayoffSummary';
import { Header } from '../src/components/Header';
import { EquityCard, EquityBody, EquityCta, EquitySetupTeaser } from '../src/components/EquityCard';

// WHIT-233: the home-loan detail screen, relocated out of the Goal tab (which is now the
// Goals hub). It's a stack route under the root <Stack> — OUTSIDE NavBarsProvider — so it
// can't use the tab's ScrollChromeHeader (that needs the provider); it uses the shared
// <Header /> + a plain ScrollView, the same detail-screen pattern as milestone.tsx /
// loan.tsx. The content + the useGoalScreenData reads are otherwise unchanged.
export default function Mortgage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // WHIT-197: the live balance, last repayment, and loan facts come from the cached query
  // layer. Re-check on focus, but only if the cache has gone stale (no request storm).
  const {
    loanFacts, homeLoan, homeLoanLoaded, repayment, milestones, repaymentError, homeLoanError, loanFactsLoaded, loanFactsError,
    isLoading, refetch, refetchStale,
  } = useGoalScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  const g = goalView({ loanFacts, homeLoan });
  const m = milestoneView({ loanFacts, homeLoan, milestones });
  const lr = lastRepaymentView({ repayment });
  const p = paydownView({ loanFacts, homeLoan });
  // WHIT-821: inferred on the phone — the balance check worked but found nothing, nothing's
  // set up, and no repayment on record (any repayment, even a half one, proves a loan exists).
  const noHomeLoan = homeLoanLoaded && loanFactsLoaded && homeLoan.balance == null && !g.factsReady
    && !lr.present && !lr.malformed && !repaymentError;
  // WHIT-215: one hint element, used in both mutually-exclusive 'none' arms (figure shown
  // vs suppressed) so the copy + testID can't drift between them.
  const tooSoonHint = <Text style={styles.miniHint} testID="goal-too-aggressive-hint">That target may be too soon — try a later date.</Text>;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Home loan" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {/* hero — real payoff progress once loan facts are set, else a set-up prompt
            that still shows the one thing we genuinely know: the live balance. */}
        <View style={styles.hero}>
          <HeroGradientFill />
          <View style={styles.heroBlob} />
          {g.paidDownReady ? (
            <PayoffSummary
              variant="hero"
              paidOff={g.paidOff!}
              paidPctLabel={g.paidPctLabel}
              paidPct={g.paidPct}
              balanceLabel={g.balanceLabel}
              original={g.original!}
            />
          ) : loanFactsError ? (
            // WHIT-819: errors come before "not set up" — a failed facts read falls back to
            // empty facts, which must never look like an unset loan.
            <HeroRetry text="Couldn't load your loan details." label="Retry loading your loan details" testID="hero-facts-retry" onRetry={refetch} />
          ) : homeLoanError ? (
            // WHIT-121 (#2), reordered by WHIT-819: the balance read FAILED. Show an error +
            // Retry whether or not facts are set, instead of a bare "—" or the waiting copy.
            // Mirrors milestone.tsx's homeLoanError hero branch.
            <HeroRetry text="Couldn't load your balance." label="Retry loading your balance" testID="hero-balance-retry" onRetry={refetch} />
          ) : !loanFactsLoaded || (!g.factsReady && isLoading) ? (
            // WHIT-819: facts still loading — a quiet placeholder, no set-up copy. WHIT-821: when
            // not set up, also wait for the balance + repayment so "no home loan" can't flash.
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]} testID="hero-facts-loading">{g.balanceLabel}</Text>
            </>
          ) : noHomeLoan ? (
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN</Text>
              <Text style={styles.heroSetupBody} testID="hero-no-home-loan">
                We didn't find a home loan in your linked accounts. If you add one, it'll show up here.
              </Text>
            </>
          ) : !g.factsReady ? (
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]}>{g.balanceLabel}</Text>
              <Text style={styles.heroSetupBody}>
                Add 6 quick facts about your loan (about a minute) to see how much you've paid down and when you'll be mortgage-free.
              </Text>
              <Pressable onPress={() => router.push('/loan')} style={styles.heroSetupBtn} accessibilityRole="button">
                <Text style={styles.heroSetupBtnText}>Set up loan details →</Text>
              </Pressable>
            </>
          ) : g.balanceKnown ? (
            // WHIT-372: facts + balance are both loaded, but nothing's genuinely paid down — the
            // balance is at or above the original (a fresh loan, or a redraw/refinance that grew
            // it). Show the real balance owing with an honest "you're at the start" line, never the
            // incoherent "$1 paid / 0% gone" payoff block the un-gated hero used to render.
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]}>{g.balanceLabel}</Text>
              <Text style={styles.heroSetupBody}>You're at the start — your payoff progress will show here as you pay it down.</Text>
            </>
          ) : (
            // Facts are set, but the live balance hasn't loaded yet — don't imply
            // "set up needed"; just wait on the balance.
            <>
              <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
              <Text style={[styles.heroBig, { marginTop: 6 }]}>{g.balanceLabel}</Text>
              <Text style={styles.heroSetupBody}>We'll show your payoff progress once your balance loads.</Text>
            </>
          )}
        </View>

        {/* freedom + interest — real payoff projection (WHIT-114) from the live
            balance + saved facts. Three honest states: pays off with room to spare
            (date + how much sooner/interest the extra saves), pays off only because
            of the extra (date alone), or won't pay off at this rate (a nudge). */}
        {p.mode === 'ahead' && (
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            <View style={styles.miniCard}>
              <View style={styles.miniHead}><Glyph name="check" size={15} color={C.accentSoft} /><Text style={styles.miniLabel}>Mortgage-free</Text></View>
              <Text style={styles.miniValue}>{p.freedomLabel}</Text>
              <Text style={[styles.miniSub, { color: C.good }]}>{p.aheadLabel} early 🏁</Text>
            </View>
            <View style={styles.miniCard}>
              <View style={styles.miniHead}><Glyph name="dollar" size={15} color={C.accentSoft} /><Text style={styles.miniLabel}>Interest you'll dodge</Text></View>
              <Text style={styles.miniValue}>{p.interestDodgedLabel}</Text>
              <Text style={styles.miniSub}>never going to the bank</Text>
            </View>
          </View>
        )}
        {(p.mode === 'partial' || p.mode === 'flat') && (
          <View style={[styles.miniCard, { marginBottom: 12 }]}>
            <View style={styles.miniHead}><Glyph name="check" size={15} color={C.accentSoft} /><Text style={styles.miniLabel}>Mortgage-free</Text></View>
            <Text style={styles.miniValue}>{p.freedomLabel}</Text>
            <Text style={[styles.miniSub, p.mode === 'partial' && { color: C.good }]}>
              {p.mode === 'partial' ? 'Your extra repayment is what gets you there 🏁' : 'On your current repayments'}
            </Text>
          </View>
        )}
        {p.mode === 'none' && (
          <View style={[styles.miniCard, { marginBottom: 12 }]}>
            <View style={styles.miniHead}><Glyph name="clock" size={15} color={C.warn} /><Text style={styles.miniLabel}>Payoff</Text></View>
            <Text style={[styles.miniValue, { fontSize: 15 }]}>Won't pay off at this rate</Text>
            {p.requiredRepay != null ? (
              <>
                <Text style={styles.miniSub}>
                  To clear it by {p.goalDateLabel} you'd need {p.requiredRepayLabel}/month — {p.requiredExtraLabel} more than now.
                </Text>
                {/* WHIT-215: an honest but absurd figure (below $1M) — nudge a later date under it. */}
                {p.goalTooAggressive && tooSoonHint}
              </>
            ) : p.goalTooAggressive ? (
              // WHIT-215: figure suppressed (over the $1M cap) — the hint explains WHY the
              // date is unrealistic, in place of the generic "increase your repayment" line.
              tooSoonHint
            ) : (
              <Text style={styles.miniSub}>Increase your repayment to clear the loan.</Text>
            )}
          </View>
        )}

        {/* WHIT-821: no home loan → only the calm explainer above, no secondary cards. */}
        {!noHomeLoan && (<>
        {/* Milestone plan — the user's own sprints (empty until they set one), taps into the full screen */}
        <Pressable testID="milestone-link" onPress={() => router.push(m.hasPlan ? '/milestone' : '/milestone/edit')} style={styles.card}>
          {!m.hasPlan ? (
            <>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>Set your payoff milestones</Text>
                <Glyph name="plus" size={16} color={C.accentSoft} />
              </View>
              <Text style={[styles.cardTitle, { color: C.accentSofter, fontSize: 12.5, marginTop: 2 }]}>
                Add your own targets to track your progress to a paid-off home →
              </Text>
            </>
          ) : (
            <>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>
                  {m.hasBalance ? `${m.clearedCount} of ${m.total} sprints reached` : 'Your payoff plan'}
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
            </>
          )}
        </Pressable>

        {/* contribution — from the user's saved scheduled + extra repayment */}
        {g.factsReady && (
          <View style={styles.contribCard}>
            <Text style={styles.contribEyebrow}>HEADING TO THE LOAN THIS MONTH</Text>
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
          ) : repaymentError || lr.malformed ? (
            // WHIT-121: the repayment read FAILED (repaymentError, no cached value) OR the
            // server sent an unusable half-payload (lr.malformed — amount xor date). Either
            // way show an error + Retry instead of the empty state, which would falsely tell a
            // user they have no repayment. lr.present takes precedence above, so a cached
            // repayment surviving a background-refetch failure still shows the real card.
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.repayChip, { backgroundColor: 'rgba(255,255,255,.06)' }]}><Glyph name="arrowDown" size={22} color={C.textFaint} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.repayTitle}>Last repayment</Text>
                <Text style={styles.repaySub} accessibilityLiveRegion="polite">Couldn't load your last repayment.</Text>
              </View>
              <RetryButton onPress={() => refetch()} label="Retry loading your last repayment" testID="repayment-retry" style={styles.repayRetryBtn} textStyle={styles.repayRetryText} />
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
        </View>

        {/* usable equity from the home — how much the user could unlock from their
            current home toward the deposit on their next place, once the value is set. */}
        <EquityCard
          right={g.usableEquity != null && g.depositPct != null && <View style={styles.ipPct}><Text style={styles.ipPctText}>{Math.round(g.depositPct)}%</Text></View>}
        >
          {g.usableEquity != null ? (
            g.depositTarget != null && g.depositPct != null ? (
              // Deposit target set → real progress toward the user's own number.
              <>
                <Bar pct={g.depositPct} color={C.purple} height={10} />
                <View style={[styles.cardHead, { marginTop: 9, marginBottom: 0 }]}>
                  <Text style={[styles.cardTitle, { color: '#d9c9f7', fontSize: 12.5 }]}>{fmt(g.usableEquity)} unlocked</Text>
                  <Text style={styles.cardHint}>of {fmt(g.depositTarget)} needed</Text>
                </View>
                <EquityBody>Keep chipping away — the more principal you clear, the more equity you can put toward your next place. 📈</EquityBody>
              </>
            ) : (
              // Equity known, but no deposit target yet — show the real figure, never a
              // fabricated denominator; nudge the user to set their target.
              <>
                <Text style={[styles.cardTitle, { color: '#d9c9f7', fontSize: 12.5 }]}>{fmt(g.usableEquity)} unlocked</Text>
                <EquityBody>Set your deposit target and we'll track how close this gets you to your next place. 📈</EquityBody>
                <EquityCta label="Set deposit target →" />
              </>
            )
          ) : g.factsReady ? (
            // Property value is set; the equity figure just needs the live balance.
            <EquityBody>Your usable equity will show once your balance loads.</EquityBody>
          ) : (
            loanFactsLoaded && <EquitySetupTeaser />
          )}
        </EquityCard>
        </>)}
      </ScrollView>
    </View>
  );
}

function HeroRetry({ text, label, testID, onRetry }: { text: string; label: string; testID: string; onRetry: () => void }) {
  return (
    <>
      <Text style={styles.heroEyebrow}>YOUR HOME LOAN · BALANCE OWING</Text>
      <Text style={[styles.heroSetupBody, { marginTop: 6 }]} accessibilityLiveRegion="polite">{text}</Text>
      <RetryButton onPress={() => onRetry()} label={label} testID={testID} style={styles.heroSetupBtn} textStyle={styles.heroSetupBtnText} />
    </>
  );
}

const styles = StyleSheet.create({

  hero: { position: 'relative', overflow: 'hidden', borderRadius: 26, padding: 22, paddingBottom: 20, marginBottom: 14, backgroundColor: C.accent },
  heroBlob: { position: 'absolute', right: -26, top: -26, width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(255,255,255,.1)' },
  heroEyebrow: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.heroInkSoft, letterSpacing: 0.3 },
  heroBig: { fontFamily: FONT.display, fontSize: 48, fontWeight: '800', color: C.heroInk, lineHeight: 48, letterSpacing: -2 },
  heroSetupBody: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.heroInk2, lineHeight: 20, marginTop: 10 },
  heroSetupBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', backgroundColor: C.heroInkWash, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 14, marginTop: 14 },
  heroSetupBtnText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.heroInk },

  miniCard: { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 14 },
  miniHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniLabel: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.accentSoft },
  miniValue: { fontFamily: FONT.display, fontSize: 20, fontWeight: '800', color: C.text, marginTop: 5, letterSpacing: -0.4 },
  miniSub: { fontFamily: FONT.body, fontSize: 11.5, color: C.textDim, fontWeight: '600', marginTop: 2 },
  // WHIT-215: the "too soon — try a later date" nudge. Warn-tinted so it reads as guidance,
  // distinct from the plain gray sub-copy.
  miniHint: { fontFamily: FONT.body, fontSize: 11.5, color: C.warn, fontWeight: '600', marginTop: 4 },

  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 16, marginBottom: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardTitle: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.textBright },
  cardHint: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },

  planSchedule: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', marginTop: 8 },

  contribCard: { backgroundColor: tint(C.accentAlt, 0.1), borderWidth: 1, borderColor: tint(C.accentAlt, 0.22), borderRadius: 18, padding: 16, marginBottom: 12 },
  contribEyebrow: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSofter },
  contribBig: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: '#fff', letterSpacing: -1, marginTop: 4 },
  contribBody: { fontFamily: FONT.body, fontSize: 13, color: '#a6a6b0', lineHeight: 19, marginTop: 6 },
  contribStrong: { color: '#e6e6ea', fontWeight: '700' },

  repayChip: { width: 42, height: 42, borderRadius: 13, backgroundColor: tint(C.good, 0.14), alignItems: 'center', justifyContent: 'center' },
  repayTitle: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.textBright },
  repaySub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  repayAmount: { fontFamily: FONT.display, fontSize: 18, fontWeight: '800', color: C.good },
  // WHIT-121: the repayment-error Retry chip. Sits inline on the dark card, so it uses an
  // accent tint (milestone's retryBtn is hero-ink, tuned for the light hero — wrong here).
  repayRetryBtn: { backgroundColor: tint(C.accentAlt, 0.14), borderRadius: 10, paddingVertical: 7, paddingHorizontal: 14 },
  repayRetryText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.accentSoft },

  ipPct: { backgroundColor: 'rgba(201,179,245,.14)', paddingVertical: 3, paddingHorizontal: 9, borderRadius: 8 },
  ipPctText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: C.purple },
});
