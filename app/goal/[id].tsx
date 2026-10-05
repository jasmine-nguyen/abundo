import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, tint } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { balanceGoalView } from '../../src/context';
import { useGoalsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { GoalHead, GoalProgress } from '../../src/components/GoalProgress';

// WHIT-749: a goal's read-only page, reached by tapping its card on the Goals tab. Progress,
// pace and each milestone (reached or not), with Edit in the header. Delete lives only in Edit.
export default function GoalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const d = useGoalsScreenData(); // same warm cache as the Goals tab
  const goal = d.goals.find((g) => g.id === id);

  // WHIT-72 pattern: a first-load pay-cycle failure would pace against the default cycle (wrong).
  if (!goal || d.payCycleError) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
        <Header title="Goal" />
      </View>
    );
  }

  const view = balanceGoalView({ goal, balance: d.balanceFor(goal.account_id), payCycle: d.payCycle });
  const editGoal = () => router.push(`/goal/edit?id=${encodeURIComponent(goal.id)}`);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header
        title="Goal"
        right={
          <Pressable testID="goal-detail-edit" onPress={editGoal} hitSlop={8}>
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <GoalHead goal={goal} view={view} />
          <GoalProgress goal={goal} view={view} onPastDue={editGoal} />
        </View>

        {goal.checkpoints && goal.checkpoints.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>MILESTONES</Text>
            <View style={styles.card}>
              {goal.checkpoints.map((cp, i) => {
                const reached = view.checkpointReached?.[i] === true;
                return (
                  <View key={cp.id} testID={`goal-milestone-${cp.id}`} style={[styles.milestone, i > 0 && styles.milestoneDivider]}>
                    <View style={[styles.tick, reached && styles.tickReached]}>
                      {reached && (
                        <View testID={`goal-milestone-reached-${cp.id}`}>
                          <Glyph name="check" size={14} color={C.good} />
                        </View>
                      )}
                    </View>
                    <Text style={styles.milestoneLabel} numberOfLines={2}>{cp.label}</Text>
                    <Text style={styles.milestoneAmount}>{fmt(cp.amount)}</Text>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  edit: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft, paddingHorizontal: 4 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 18 },
  sectionLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 22, marginBottom: 8, marginHorizontal: 4 },
  milestone: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  milestoneDivider: { borderTopWidth: 1, borderTopColor: C.hairline },
  tick: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: C.hairline, alignItems: 'center', justifyContent: 'center' },
  tickReached: { borderColor: tint(C.good, 0.4), backgroundColor: tint(C.good, 0.14) },
  milestoneLabel: { flex: 1, fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.text },
  milestoneAmount: { fontFamily: FONT.display, fontSize: 14, fontWeight: '700', color: C.textMid },
});
