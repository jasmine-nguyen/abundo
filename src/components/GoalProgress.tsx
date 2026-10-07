import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT, fmt, tint } from '../theme';
import { formatMonthYear } from '../dateutil';
import type { BalanceGoalStatus, BalanceGoalView } from '../context';
import type { GoalRecord } from '../api';
import { Icon, Glyph } from '../icons';
import { sortCheckpointsForDirection } from '../checkpoints';
import { Bar } from './ui';

// WHIT-749: a goal's head row — icon chip, name, "Saving toward $Y · by Mon YYYY" and the
// headline % (only when there's a bar to back it). Shared by the Goals-tab card and the goal page.
export function GoalHead({ goal, view, chevron }: { goal: GoalRecord; view: BalanceGoalView; chevron?: boolean }) {
  const pct = view.progress != null ? Math.round(view.progress * 100) : null;
  return (
    <View style={styles.head}>
      <View style={styles.chip}><Icon name={goal.icon} size={22} color={C.accentSoft} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{goal.name}</Text>
        <Text style={styles.sub}>
          {goal.direction === 'grow' ? 'Saving toward' : 'Paying down'} {fmt(goal.target_amount)} · by {formatMonthYear(goal.target_date)}
        </Text>
      </View>
      {pct != null && <Text style={styles.pct}>{pct}%</Text>}
      {chevron && <Glyph name="chevron" size={16} color={C.textDim} />}
    </View>
  );
}

// WHIT-748: the calm pace pill. Behind is amber, never the alarm rose.
function paceLabel(status: BalanceGoalStatus | null, aheadBy: number | null): { text: string; color: string } | null {
  if (status === 'on_track') return { text: 'On pace', color: C.good };
  if (status === 'behind') return { text: 'A little behind', color: C.warn };
  if (status !== 'ahead') return null;
  if (aheadBy != null && aheadBy >= 1) return { text: `Ahead by ${fmt(aheadBy)}`, color: C.good };
  return { text: 'Ahead', color: C.good };
}

function amountLabel(goal: GoalRecord, view: BalanceGoalView): string | null {
  if (view.movedAmount != null && view.spanAmount != null) return `${fmt(view.movedAmount)} of ${fmt(view.spanAmount)}`;
  if (goal.direction !== 'paydown' || view.currentAmount == null) return null;
  if (goal.target_amount > 0) return `${fmt(view.currentAmount)} owed of ${fmt(goal.target_amount)} target`;
  return `${fmt(view.currentAmount)} owed`;
}

function footLeft(view: BalanceGoalView): string {
  if (view.pacePerPayday == null) return 'Waiting on your balance';
  if (view.paydaysLeft > 0) return `Set aside ${fmt(view.pacePerPayday)} each payday`;
  // 0 paydays left → pacePerPayday is already the whole remainder.
  return `${fmt(view.pacePerPayday)} to go`;
}

// The closest milestone not yet reached, in the goal's direction; null once all are reached.
// Only call once view.checkpointReached is known.
function nextMilestoneLabel(goal: GoalRecord, view: BalanceGoalView): string | null {
  const unreached = (goal.checkpoints ?? []).filter((_, i) => !view.checkpointReached![i]);
  return sortCheckpointsForDirection(unreached, goal.direction)[0]?.label ?? null;
}

function footRight(view: BalanceGoalView): string | null {
  if (view.paydaysLeft > 0) return `${view.paydaysLeft} payday${view.paydaysLeft === 1 ? '' : 's'} left`;
  if (view.pastDue) return null;
  return 'before your next payday';
}

// WHIT-749: a goal's progress block — bar, amount line, pace pill, milestones count and the
// pace foot. Shared by the Goals-tab card and the goal page so the two can't drift.
export function GoalProgress({ goal, view, onPastDue }: { goal: GoalRecord; view: BalanceGoalView; onPastDue: () => void }) {
  const pace = view.targetReached ? null : paceLabel(view.status, view.aheadBy);
  const amount = amountLabel(goal, view);
  // A met goal past its date has nothing to nudge about — it falls through to the normal foot.
  const nudge = view.pastDue && (view.pacePerPayday == null || view.pacePerPayday > 0);
  const right = footRight(view);
  const showMilestones = view.checkpointMarkers.length > 0 && view.checkpointsReached != null;
  const nextMilestone = showMilestones ? nextMilestoneLabel(goal, view) : null;

  return (
    <>
      {view.progress != null && (
        <View style={{ marginTop: 13 }}>
          {/* WHIT-486: feed the raw (unrounded) fill so a checkpoint dot never sits a pixel off
              the fill edge; the rounded % is only the headline number. */}
          <Bar
            pct={view.progress * 100}
            color={goal.direction === 'grow' ? C.goodBright : C.purple}
            height={10}
            markers={view.checkpointMarkers}
          />
        </View>
      )}

      {(amount || pace) && (
        <View style={styles.meta}>
          {amount && <Text testID={`goal-amount-${goal.id}`} style={styles.amount}>{amount}</Text>}
          {pace && (
            <View testID={`goal-pace-${goal.id}`} style={[styles.pacePill, { backgroundColor: tint(pace.color, 0.14) }]}>
              <Text style={[styles.pacePillText, { color: pace.color }]}>{pace.text}</Text>
            </View>
          )}
        </View>
      )}

      {/* WHIT-486: the count travels with the dots — both show only when the bar has a scale to
          place them on (markers non-empty), so it's never "N reached" + no dots. */}
      {showMilestones && (
        <Text testID={`goal-checkpoints-${goal.id}`} style={styles.checkpoints}>
          {nextMilestone == null ? 'All milestones reached' : `Next: ${nextMilestone}`}
        </Text>
      )}

      {view.targetReached ? (
        <View style={styles.foot}>
          <Text testID={`goal-reached-${goal.id}`} style={styles.reached}>Goal reached</Text>
        </View>
      ) : nudge ? (
        <Pressable testID={`goal-pastdue-${goal.id}`} onPress={onPastDue} hitSlop={8} style={styles.foot}>
          <Text style={styles.footLink}>Past your date — pick a new one?</Text>
        </Pressable>
      ) : (
        <View style={styles.foot}>
          <Text style={styles.footText}>{footLeft(view)}</Text>
          {right && <Text style={styles.footR}>{right}</Text>}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  chip: { width: 42, height: 42, borderRadius: 13, backgroundColor: tint(C.accentAlt, 0.14), alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: FONT.body, fontSize: 15.5, fontWeight: '700', color: C.textBright, letterSpacing: -0.2 },
  sub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  pct: { fontFamily: FONT.display, fontSize: 18, fontWeight: '800', color: C.text, letterSpacing: -0.5 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  amount: { fontFamily: FONT.display, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: -0.2 },
  pacePill: { borderRadius: 12, paddingVertical: 4, paddingHorizontal: 10 },
  pacePillText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  checkpoints: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim, marginTop: 8 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 11 },
  footText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.text },
  footLink: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.accentSoft },
  footR: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },
  reached: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.good },
});
