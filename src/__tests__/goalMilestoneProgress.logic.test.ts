// WHIT-812 — checkpointProgress: per milestone, reached or "$X to go", plus the next milestone and
// whether every one is reached. Input → output; one row fed by the REAL balanceGoalView so the
// reached marks and to-go amounts are proven to agree with the bar.
import { describe, it, expect } from '@jest/globals';
import { checkpointProgress } from '../checkpoints';
import { goal, view } from './support/goalPace';
import type { GoalCheckpoint, GoalRecord } from '../api';

type View = { currentAmount: number | null; checkpointReached: boolean[] | null };

const GROW_LADDER: GoalCheckpoint[] = [
  { id: 'c1', label: 'Small buffer', amount: 2000 },
  { id: 'c2', label: 'Big buffer', amount: 5000 },
  { id: 'c3', label: 'Nearly there', amount: 7500 },
];
// Pay-down ladder in climb order (descending owed).
const PAYDOWN_LADDER: GoalCheckpoint[] = [
  { id: 'm15', label: 'Under fifteen', amount: 15000 },
  { id: 'm10', label: 'Under ten', amount: 10000 },
  { id: 'm5', label: 'Under five', amount: 5000 },
];
const REAL_LADDER: GoalCheckpoint[] = [
  { id: 'r1', label: 'First', amount: 2000 },
  { id: 'r2', label: 'Second', amount: 7500 },
];
const realView = view(goal({ checkpoints: REAL_LADDER }), 5000);
// WHIT-817: ladders saved out of order (older goals, or written straight to the server).
const PAYDOWN_SAVED_OUT_OF_ORDER = [PAYDOWN_LADDER[2], PAYDOWN_LADDER[0], PAYDOWN_LADDER[1]];
const GROW_SAVED_OUT_OF_ORDER = [GROW_LADDER[2], GROW_LADDER[0], GROW_LADDER[1]];

const CASES: {
  name: string; checkpoints: GoalCheckpoint[]; direction: GoalRecord['direction']; view: View;
  rows: { id: string; reached: boolean | null; toGo: number | null }[]; next: string | null; allReached: boolean;
}[] = [
  {
    name: 'grow: reached rows have no to-go, a sub-dollar gap rounds up, next is the first unreached',
    checkpoints: GROW_LADDER, direction: 'grow',
    view: { currentAmount: 2999.5, checkpointReached: [true, false, false] },
    rows: [{ id: 'c1', reached: true, toGo: null }, { id: 'c2', reached: false, toGo: 2001 }, { id: 'c3', reached: false, toGo: 4501 }],
    next: 'c2', allReached: false,
  },
  {
    name: 'paydown: to-go is what is still owed above the milestone',
    checkpoints: PAYDOWN_LADDER, direction: 'paydown',
    view: { currentAmount: 9000, checkpointReached: [true, true, false] },
    rows: [{ id: 'm15', reached: true, toGo: null }, { id: 'm10', reached: true, toGo: null }, { id: 'm5', reached: false, toGo: 4000 }],
    next: 'm5', allReached: false,
  },
  {
    name: 'unknown balance: nothing reached or to go, no next',
    checkpoints: GROW_LADDER, direction: 'grow',
    view: { currentAmount: null, checkpointReached: null },
    rows: [{ id: 'c1', reached: null, toGo: null }, { id: 'c2', reached: null, toGo: null }, { id: 'c3', reached: null, toGo: null }],
    next: null, allReached: false,
  },
  {
    name: 'every milestone reached: no next, allReached',
    checkpoints: GROW_LADDER, direction: 'grow',
    view: { currentAmount: 8000, checkpointReached: [true, true, true] },
    rows: [{ id: 'c1', reached: true, toGo: null }, { id: 'c2', reached: true, toGo: null }, { id: 'c3', reached: true, toGo: null }],
    next: null, allReached: true,
  },
  {
    name: 'empty ladder: no rows, no next, not allReached',
    checkpoints: [], direction: 'grow',
    view: { currentAmount: 5000, checkpointReached: [] },
    rows: [], next: null, allReached: false,
  },
  {
    name: 'the real balanceGoalView output agrees with the bar',
    checkpoints: REAL_LADDER, direction: 'grow', view: realView,
    rows: [{ id: 'r1', reached: true, toGo: null }, { id: 'r2', reached: false, toGo: 2500 }],
    next: 'r2', allReached: false,
  },
  {
    name: 'paydown saved out of order: next is the closest unreached',
    checkpoints: PAYDOWN_SAVED_OUT_OF_ORDER, direction: 'paydown',
    view: view(goal({ direction: 'paydown', target_amount: 0, checkpoints: PAYDOWN_SAVED_OUT_OF_ORDER }), -12000),
    rows: [{ id: 'm15', reached: true, toGo: null }, { id: 'm10', reached: false, toGo: 2000 }, { id: 'm5', reached: false, toGo: 7000 }],
    next: 'm10', allReached: false,
  },
  {
    name: 'grow saved out of order: reached marks follow their milestone',
    checkpoints: GROW_SAVED_OUT_OF_ORDER, direction: 'grow',
    view: { currentAmount: 3000, checkpointReached: [false, true, false] },
    rows: [{ id: 'c1', reached: true, toGo: null }, { id: 'c2', reached: false, toGo: 2000 }, { id: 'c3', reached: false, toGo: 4500 }],
    next: 'c2', allReached: false,
  },
];

describe('checkpointProgress', () => {
  it.each(CASES)('$name', ({ checkpoints, direction, view: v, rows, next, allReached }) => {
    const result = checkpointProgress(checkpoints, direction, v);
    expect(result.rows.map((r) => ({ id: r.checkpoint.id, reached: r.reached, toGo: r.toGo }))).toEqual(rows);
    expect(result.next?.checkpoint.id ?? null).toBe(next);
    expect(result.allReached).toBe(allReached);
  });
});
