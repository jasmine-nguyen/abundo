import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT, fmt, tint } from '../theme';
import { formatMonthYear, formatDayMonthYear, isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from '../dateutil';
import type { BalanceGoalStatus, BalanceGoalView } from '../context';
import type { GoalRecord } from '../api';
import { Icon } from '../icons';
import { Bar } from './ui';

// WHIT-749: a goal's head row — icon chip, name, "Saving toward $Y · by Mon YYYY" and the
// headline % (only when there's a bar to back it). Shared by the Goals-tab card and the goal page.
export function GoalHead({ goal, view }: { goal: GoalRecord; view: BalanceGoalView }) {
  const pct = view.progress != null ? Math.round(view.progress * 100) : null;
  return (
    <View style={styles.head}>
      <View style={styles.chip}><Icon name={goal.icon} size={22} color={C.accentSoft} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{goal.name}</Text>
        <Text style={styles.sub}>
          {/* WHIT-812: non-breaking spaces keep "by Jun 2029" on one line. */}
          {goal.direction === 'grow' ? 'Saving toward' : 'Paying down'} {fmt(goal.target_amount)} · {`by ${formatMonthYear(goal.target_date).replace(' ', ' ')}`}
        </Text>
      </View>
      {pct != null && <Text style={styles.pct}>{pct}%</Text>}
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
  if (view.paydaysLeft > 0) return `${fmt(view.pacePerPayday)} / payday`;
  // 0 paydays left → pacePerPayday is already the whole remainder.
  return `${fmt(view.pacePerPayday)} to go`;
}

function footRight(view: BalanceGoalView): string | null {
  if (view.paydaysLeft > 0) return `${view.paydaysLeft} payday${view.paydaysLeft === 1 ? '' : 's'} left`;
  if (view.pastDue) return null;
  return 'before your next payday';
}

// WHIT-749: a goal's progress block — bar, amount line, pace pill, milestones count and the
// pace foot. Shared by the Goals-tab card and the goal page so the two can't drift.
// hideMilestoneCount: the goal page shows its own "Next: …" line instead of the count (WHIT-812).
export function GoalProgress({ goal, view, onPastDue, hideMilestoneCount = false }: {
  goal: GoalRecord; view: BalanceGoalView; onPastDue: () => void; hideMilestoneCount?: boolean;
}) {
  const pace = view.targetReached ? null : paceLabel(view.status, view.aheadBy);
  const amount = amountLabel(goal, view);
  // A met goal past its date has nothing to nudge about — it falls through to the normal foot.
  const nudge = view.pastDue && (view.pacePerPayday == null || view.pacePerPayday > 0);
  const right = footRight(view);

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
      {!hideMilestoneCount && view.checkpointMarkers.length > 0 && view.checkpointsReached != null && (
        <Text testID={`goal-checkpoints-${goal.id}`} style={styles.checkpoints}>
          {view.checkpointsReached} of {view.checkpointsTotal} milestone{view.checkpointsTotal === 1 ? '' : 's'} reached
        </Text>
      )}

      {view.targetReached ? (
        <View style={styles.foot}>
          <Text testID={`goal-reached-${goal.id}`} style={styles.reached}>Goal reached</Text>
        </View>
      ) : nudge ? (
        <Pressable testID={`goal-pastdue-${goal.id}`} onPress={onPastDue} hitSlop={8} style={styles.foot}>
          <Text style={styles.footL}>Past your date — pick a new one?</Text>
        </Pressable>
      ) : (
        <View style={styles.foot}>
          <Text style={styles.footL}>{footLeft(view)}</Text>
          {right && <Text style={styles.footR}>{right}</Text>}
        </View>
      )}
    </>
  );
}

// WHIT-235: a manual balance is "stale" once it hasn't been updated in over 30 days — the
// number the pace math trusts is getting old, so the row nudges the user to refresh it.
const STALE_DAYS = 30;
function balanceIsStale(manualAsOf: string | null | undefined): boolean {
  if (!manualAsOf) return false;
  return wholeDaysBetween(isoToUtcDayMs(manualAsOf), dateToUtcDayMs(new Date())) > STALE_DAYS;
}

// WHIT-235 / WHIT-812: a manual goal's (no synced account) "Balance as of <date>" + Update balance
// row. Shared by the Goals-tab card and the goal page. Synced goals track the live feed: no row.
export function GoalBalanceRow({ goal, onUpdate }: { goal: GoalRecord; onUpdate: () => void }) {
  if (goal.account_id) return null;
  const stale = balanceIsStale(goal.manual_as_of);
  return (
    <View style={styles.manualRow}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.asOf} numberOfLines={1}>
          {goal.manual_as_of ? `Balance as of ${formatDayMonthYear(goal.manual_as_of)}` : 'Balance not set'}
        </Text>
        {stale && <Text style={styles.staleTag}>Haven’t updated in a while</Text>}
      </View>
      <Pressable testID={`goal-balance-${goal.id}`} onPress={onUpdate} hitSlop={8} style={styles.updateBtn}>
        <Text style={styles.updateText}>Update balance</Text>
      </Pressable>
    </View>
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
  footL: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.accentSoft },
  footR: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },
  reached: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.good },
  manualRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.hairline },
  asOf: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.textDim },
  staleTag: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: C.warn, marginTop: 2 },
  updateBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 11, backgroundColor: tint(C.accentAlt, 0.14) },
  updateText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.accentSoft },
});
