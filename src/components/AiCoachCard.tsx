import { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, AccessibilityInfo } from 'react-native';
import { C, FONT, tint, agoLabel } from '../theme';
import { Glyph } from '../icons';
import { aiGoalSignal } from '../context';
import { useAiInsights } from '../hooks/useAiInsights';
import { useGoalScreenData } from '../queries';
import { useChat } from '../chat/ChatContext';

// The Insights "coach" card (WHIT-104), extracted from the Insights screen (WHIT-68) so the
// screen can gate it behind `{cycle === 0 && <AiCoachCard />}` in one line and its AI-state
// wiring lives in one place. It reads the AI insights off useAiInsights() and the
// home-loan goal inputs off the query layer (useGoalScreenData) itself, so the screen passes
// nothing. Because it only mounts on the current cycle, the loading→done screen-reader announce
// below can never fire for an off-screen card (the WHIT-68 look-back hazard): switching to a
// past cycle unmounts this component, so its effect simply doesn't run.
export function AiCoachCard() {
  const { insights: ai, isLoading, isError, generate } = useAiInsights();
  // WHIT-203: the goal signal's inputs (loan facts + live balance) come off the query layer.
  const { loanFacts, homeLoan } = useGoalScreenData();
  const { openChat } = useChat();

  const hasAi = !!(ai && (ai.summary || ai.suggestions.length > 0));
  const ago = agoLabel(ai?.generated_at);

  // WHIT-142: while a re-analyse runs, the labelled refresh button is replaced by a bare
  // spinner and the result lands silently — a screen-reader user hears nothing after they
  // tap. Announce the outcome on the loading → done edge. Only generate toggles
  // isLoading (it clears isError at the start of the run, so the flag reflects
  // THIS run at the edge), and the on-focus refresh never touches it — so this fires
  // once per real analyse/re-analyse, never on mount or tab focus. Ref starts undefined so a
  // screen that mounts mid-load doesn't announce a transition it didn't witness.
  const wasAnalysing = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (wasAnalysing.current && !isLoading) {
      AccessibilityInfo.announceForAccessibility?.(
        // Control-agnostic: on first run the retry control reads "Try again"; on a re-run it's
        // the "Re-analyse my spending" refresh — so name neither, just prompt the retry.
        isError
          ? "Couldn't analyse your spending. Please try again."
          : 'Spending analysis ready.',
      );
    }
    wasAnalysing.current = isLoading;
  }, [isLoading, isError]);

  // The home-loan goal signal (WHIT-134) — non-null only when there's an honest payoff
  // projection to send. Computed from live state and passed INTO generate at tap
  // time (never stale). Also drives the privacy note: we only claim loan figures are sent
  // when a goal is actually attached.
  const goal = aiGoalSignal({ loanFacts, homeLoan });
  const noteSends = goal
    ? 'category spend totals and home-loan figures (balance, rate, repayments)'
    : 'category spend totals';
  // Forward-looking in BOTH states (what the next generate/re-analyse sends), keyed to the
  // CURRENT loan readiness. Deliberately not past-tense: the shown insight may have been
  // generated before loan facts were saved, so a "figures were sent" claim could be false —
  // "re-analysing sends…" is always true.
  const noteText = hasAi
    ? `Re-analysing sends your ${noteSends} to Anthropic. Suggestions, not financial advice.`
    : `Sends your ${noteSends} to Anthropic to generate advice. Suggestions, not financial advice.`;

  return (
    <View style={styles.aiCard}>
      <View style={styles.aiHeadRow}>
        <View style={styles.aiHeadLeft}>
          <Text style={styles.aiEmoji}>👀</Text>
          <Text style={styles.aiTitle}>Worth a look</Text>
        </View>
        {/* Once an insight exists the re-run is a quiet stamp + refresh, not a big
            button — the card stays about the advice. Refresh spins while working. */}
        {hasAi && (
          <View style={styles.aiHeadRight}>
            {/* A failed re-run keeps the old advice below, but must SAY it failed
                (not just silently stop) — the refresh stays tappable to retry. */}
            {isError
              ? <Text style={styles.aiStampErr}>Couldn’t refresh</Text>
              : !!ago && <Text style={styles.aiStamp}>{ago}</Text>}
            {isLoading
              ? <ActivityIndicator testID="ai-refresh-busy" size="small" color={C.accentSoft} accessibilityLabel="Re-analysing your spending" />
              : <Pressable
                  onPress={() => generate(goal)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Re-analyse my spending"
                >
                  <Glyph name="refresh" size={17} color={C.accentSoft} />
                </Pressable>}
          </View>
        )}
      </View>

      {hasAi && !!ai?.summary && <Text style={styles.aiSummary}>{ai.summary}</Text>}
      {hasAi && ai!.suggestions.map((tip, i) => (
        <View key={i} style={styles.aiTipRow}>
          <View style={styles.aiDiamond} />
          <Text style={styles.aiTip}>{tip}</Text>
        </View>
      ))}

      {!hasAi && !isLoading && !isError && (
        <Text style={styles.aiIdle}>Get a few AI suggestions on where to cut back this cycle.</Text>
      )}
      {!hasAi && isError && (
        <Text style={styles.aiError}>Couldn’t generate insights. Please try again.</Text>
      )}

      {/* Big button only on first run / empty; re-runs use the header refresh. */}
      {!hasAi && (
        <Pressable
          style={[styles.aiBtn, isLoading && styles.aiBtnBusy]}
          disabled={isLoading}
          onPress={() => generate(goal)}
        >
          {isLoading
            ? <ActivityIndicator testID="ai-generate-busy" color={C.heroInk} accessibilityLabel="Analysing your spending" />
            : <Text style={styles.aiBtnText}>{isError ? 'Try again' : 'Analyse my spending'}</Text>}
        </Pressable>
      )}

      {/* Full disclosure before the first send (conscious choice); a compact reminder once
          populated. Anthropic is named in both, and the loan figures are named only when a
          goal is actually attached (WHIT-134). */}
      <Text style={styles.aiNote}>{noteText}</Text>

      {/* Card 609: carry on from this summary in the Ask Abundo chat — a fresh thread that opens
          with the summary as its first answer, keyboard up. */}
      {hasAi && (
        <View style={styles.aiFooter}>
          <Pressable
            testID="ai-ask-follow-up"
            onPress={() => openChat({ seed: ai!.summary || ai!.suggestions.join('\n') })}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={styles.aiFollowUp}>Ask a follow-up →</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Coach card: a soft wash + hairline so it reads as "advice", sitting between the loud hero
  // and the plain category rows. WHIT-398 moved it onto accentAlt at 0.1/0.22 so it matches the
  // other two wash cards (mortgage.tsx contribCard, milestone.tsx nextCard) — it was the last
  // surface still built from C.accent at 0.07, which made it a slightly greener, fainter blue.
  aiCard: { backgroundColor: tint(C.accentAlt, 0.1), borderWidth: 1, borderColor: tint(C.accentAlt, 0.22), borderRadius: 20, padding: 16, marginBottom: 22 },
  aiHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  aiHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  aiEmoji: { fontSize: 15 },
  aiHeadRight: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 20 },
  aiTitle: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.textBright, letterSpacing: -0.2 },
  aiStamp: { fontFamily: FONT.body, fontSize: 12, color: C.textFaint },
  aiStampErr: { fontFamily: FONT.body, fontSize: 12, color: C.bad },
  aiSummary: { fontFamily: FONT.body, fontSize: 14, color: C.text, lineHeight: 20, marginBottom: 12 },
  aiTipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  aiDiamond: { width: 6, height: 6, backgroundColor: C.accent, transform: [{ rotate: '45deg' }], marginTop: 7 },
  aiTip: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textMid, lineHeight: 20 },
  aiIdle: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, lineHeight: 20, marginBottom: 12 },
  aiError: { fontFamily: FONT.body, fontSize: 14, color: C.bad, lineHeight: 20, marginBottom: 12 },
  aiBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  aiBtnBusy: { opacity: 0.7 },
  aiBtnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.heroInk },
  aiNote: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, lineHeight: 16, marginTop: 10 },
  aiFooter: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  aiFollowUp: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.purple },
});
