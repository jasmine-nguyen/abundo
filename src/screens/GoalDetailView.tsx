import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, tint } from '../theme';
import { Glyph } from '../icons';
import { balanceGoalView, useAppContext, type BalanceGoalView } from '../context';
import { useGoalsScreenData } from '../queries';
import { checkpointProgress, type CheckpointProgressRow } from '../checkpoints';
import { Header } from '../components/Header';
import { useScrollEdge } from '../hooks/useScrollEdge';
import { useDetailBottomPadding } from '../hooks/useDetailBottomPadding';
import { usePageSidePadding } from '../hooks/useHeaderSidePadding';
import { DetailStates } from '../components/DetailStates';
import { SectionLabel } from '../components/ui';
import { EmptyState } from '../components/EmptyState';
import { GoalHead, GoalProgress, GoalBalanceRow } from '../components/GoalProgress';
import type { GoalRecord } from '../api';

// WHIT-749: a goal's read-only page, reached by tapping its card on the Goals tab. Progress,
// pace and each milestone (reached or "$X to go"), with Edit in the header. Delete lives only in Edit.
// ABU-111: with onClose it's embedded in the Goals tab's wide-screen pane (no back arrow).
export function GoalDetailView({ id, onClose }: { id: string; onClose?: () => void }) {
  const embedded = onClose !== undefined;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const edge = useScrollEdge();
  const pagePadding = usePageSidePadding();
  const d = useGoalsScreenData(); // same warm cache as the Goals tab
  const goal = d.goals.find((g) => g.id === id);
  // WHIT-72 pattern: a first-load pay-cycle failure would pace against the default cycle (wrong),
  // so the goal only renders once both primary reads have landed.
  const ready = !!goal && !d.isLoading && !d.payCycleError;
  const editGoal = () => router.push(`/goal/edit?id=${encodeURIComponent(id)}`);
  const paddingBottom = useDetailBottomPadding(embedded);

  // ABU-111: a pane goal that's gone (deleted from Edit) closes the pane rather than showing
  // "not found". Only once goals have loaded, so a cold reload doesn't close it.
  const gone = embedded && d.goalsLoaded && !d.isLoading && !goal;
  useEffect(() => {
    if (gone) onClose?.();
  }, [gone, onClose]);
  if (gone) return null;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header
        title="Goal"
        divider={edge.scrolled}
        back={!embedded}
        right={ready && (
          <Pressable testID="goal-detail-edit" onPress={editGoal} hitSlop={8}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        )}
      />
      <ScrollView {...edge.scrollProps} contentContainerStyle={{ ...pagePadding, paddingBottom }} showsVerticalScrollIndicator={false}>
        <DetailStates
          isLoading={d.isLoading} isError={d.isError} hasCache={ready} idPrefix="goal-detail"
          errorText="Couldn't load this goal." retryLabel="Retry loading this goal" onRetry={d.refetch}
        >
          {goal
            ? <GoalBody goal={goal} onEdit={editGoal} view={balanceGoalView({ goal, balance: d.balanceFor(goal.account_id), payCycle: d.payCycle })} />
            : <EmptyState testID="goal-detail-missing" title="Goal not found" sub="It may have been deleted." />}
        </DetailStates>
      </ScrollView>
    </View>
  );
}

function GoalBody({ goal, view, onEdit }: { goal: GoalRecord; view: BalanceGoalView; onEdit: () => void }) {
  const s = useAppContext(); // openGoalBalance — the global manual-balance sheet (WHIT-235)
  const { rows, next, allReached } = checkpointProgress(goal.checkpoints ?? [], goal.direction, view);

  return (
    <>
      <NextLine next={next} allReached={allReached} />
      <View style={styles.card}>
        <GoalHead goal={goal} view={view} />
        <GoalProgress goal={goal} view={view} onPastDue={onEdit} hideMilestoneCount />
        <GoalBalanceRow goal={goal} onUpdate={() => s.openGoalBalance(goal.id)} />
      </View>

      {rows.length > 0 && (
        <>
          <SectionLabel style={{ marginTop: 22 }}>MILESTONES</SectionLabel>
          <View style={styles.card}>
            {rows.map(({ checkpoint: cp, reached, toGo }, i) => (
              <View key={cp.id} testID={`goal-milestone-${cp.id}`} style={[styles.milestone, i > 0 && styles.milestoneDivider]}>
                <View style={[styles.tick, reached === true && styles.tickReached]}>
                  {reached === true && (
                    <View testID={`goal-milestone-reached-${cp.id}`}>
                      <Glyph name="check" size={14} color={C.good} />
                    </View>
                  )}
                </View>
                <Text style={styles.milestoneLabel} numberOfLines={2}>{cp.label}</Text>
                <View style={styles.milestoneRight}>
                  <Text style={styles.milestoneAmount}>{fmt(cp.amount)}</Text>
                  {toGo != null && (
                    <Text testID={`goal-milestone-togo-${cp.id}`} style={styles.milestoneToGo}>{fmt(toGo)} to go</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        </>
      )}
    </>
  );
}

// WHIT-812: "Next: <label> · $X to go", or "All milestones reached". Hidden with no milestones, or
// while the balance is unknown (nothing is reached or next yet).
function NextLine({ next, allReached }: { next: CheckpointProgressRow | null; allReached: boolean }) {
  if (next == null && !allReached) return null;
  const text = next ? `Next: ${next.checkpoint.label} · ${fmt(next.toGo ?? 0)} to go` : 'All milestones reached';
  return <Text testID="goal-detail-next" style={styles.next}>{text}</Text>;
}

const styles = StyleSheet.create({
  edit: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft, paddingHorizontal: 4 },
  next: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.textBright, marginBottom: 12, marginHorizontal: 4 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 18 },
  milestone: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  milestoneDivider: { borderTopWidth: 1, borderTopColor: C.hairline },
  tick: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: C.textDim, alignItems: 'center', justifyContent: 'center' },
  tickReached: { borderColor: tint(C.good, 0.4), backgroundColor: tint(C.good, 0.14) },
  milestoneLabel: { flex: 1, fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.text },
  milestoneRight: { alignItems: 'flex-end' },
  milestoneAmount: { fontFamily: FONT.display, fontSize: 14, fontWeight: '700', color: C.textMid },
  milestoneToGo: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim, marginTop: 2 },
});
