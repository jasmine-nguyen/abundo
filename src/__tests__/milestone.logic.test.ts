// Logic tests for milestoneView (WHIT-8) — the Sprint 0–4 paydown progress
// selector. Pure over the live home-loan balance (s.homeLoan) + the MILESTONES
// constants + an injected `today`, so no provider/network is needed.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import {
  MILESTONES,
  PROPERTY_VALUE,
  HOME_LOAN_LVR,
  milestoneTime,
  usableEquity,
  milestonesOrderingError,
  milestoneOutOfOrderRows,
  MILESTONE_BALANCE_MAX,
  MILESTONE_LABEL_MAX_LEN,
  MILESTONE_MAX_COUNT,
} from '../milestones';
import type { MilestoneRecord } from '../api';
import { makeState, EMPTY_LOAN_FACTS } from './factory';

// A UTC-midnight Date the selector reads via get*()/Date.UTC — matches how the
// milestone dates are compared. Passing the milestone's own ISO gives a `today`
// exactly on that anchor.
const onDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('MILESTONES constants', () => {
  it('are strictly ordered: increasing dates, decreasing balances', () => {
    for (let i = 1; i < MILESTONES.length; i++) {
      expect(milestoneTime(MILESTONES[i])).toBeGreaterThan(milestoneTime(MILESTONES[i - 1]));
      expect(MILESTONES[i].targetBalance).toBeLessThan(MILESTONES[i - 1].targetBalance);
    }
  });

  it('match the Notion usable-equity figures (property value + LVR pin)', () => {
    // Sprint 0: 770000 * 0.8 - 544000 = 72000; Sprint 4: -> 561000.
    expect(usableEquity(PROPERTY_VALUE, 544000)).toBe(72000);
    expect(usableEquity(PROPERTY_VALUE, 55000)).toBe(561000);
    expect(HOME_LOAN_LVR).toBe(0.8);
  });
});

describe('milestoneView — no balance yet', () => {
  it('flags hasBalance false, nulls the schedule, and shows em-dash labels', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: null, asOf: null } }));
    expect(v.hasBalance).toBe(false);
    expect(v.schedule).toBeNull();
    expect(v.balanceLabel).toBe('—');
    expect(v.usableEquityLabel).toBe('—');
    expect(v.amountToNextLabel).toBe('—');
    expect(v.clearedCount).toBe(0);
    expect(v.rows).toHaveLength(5);
    expect(v.rows.every((r) => !r.cleared)).toBe(true);
  });
});

describe('milestoneView — usable equity', () => {
  it('derives equity from the saved property value and LVR, clamped ≥ 0', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } }));
    // LOAN_FACTS: homeValue 770000, lvr 0.8 -> 770000 * 0.8 - 596642.43 = 19357.57 -> round 19358
    expect(v.equityKnown).toBe(true);
    expect(v.usableEquity).toBe(19358);
    expect(v.usableEquityLabel).toBe('$19,358');
    expect(v.propertyValue).toBe(770000);
    expect(v.rows[0].targetEquity).toBe(72000);  // 770000*0.8 - 544000
  });

  it('gates equity behind saved facts: unset -> null figures, "—" label', () => {
    const v = milestoneView(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: null } }));
    expect(v.equityKnown).toBe(false);
    expect(v.usableEquity).toBeNull();
    expect(v.usableEquityLabel).toBe('—');
    expect(v.propertyValue).toBeNull();
    expect(v.rows.every((r) => r.targetEquity === null)).toBe(true);
    // Balance-driven progress is unaffected — it doesn't need the facts.
    expect(v.hasBalance).toBe(true);
    expect(v.clearedCount).toBe(0);
  });

  it('facts saved but balance not loaded: live equity null, per-sprint targetEquity computed', () => {
    // The equityKnown × hasBalance asymmetry: LIVE equity needs both, targets need
    // only the facts — so the table shows real targets next to a "—" current equity.
    const v = milestoneView(makeState({ homeLoan: { balance: null, asOf: null } }));
    expect(v.equityKnown).toBe(true);        // facts set (factory default)…
    expect(v.hasBalance).toBe(false);        // …but no live balance
    expect(v.usableEquity).toBeNull();       // needs both -> null, never 0/NaN
    expect(v.usableEquityLabel).toBe('—');
    expect(v.propertyValue).toBe(770000);    // needs only the facts
    expect(v.rows[0].targetEquity).toBe(72000);   // 770000*0.8 - 544000
    expect(v.rows.every((r) => r.targetEquity !== null)).toBe(true);
  });

  it('never goes negative when the balance exceeds borrowing power', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 700000, asOf: null } }));
    expect(v.usableEquity).toBe(0);
  });
});

describe('milestoneView — next milestone selection', () => {
  it('picks Sprint 0 when the balance is still above every target', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 596642.43, asOf: null } }));
    expect(v.clearedCount).toBe(0);
    expect(v.nextMilestone?.sprint).toBe(0);
    expect(v.amountToNext).toBeCloseTo(52642.43, 2); // 596642.43 - 544000
  });

  it('counts a target reached at-or-below as cleared and advances the next one', () => {
    // 420000 clears Sprint 0 (544k) and Sprint 1 (420k, inclusive), next is Sprint 2 (295k).
    const v = milestoneView(makeState({ homeLoan: { balance: 420000, asOf: null } }));
    expect(v.clearedCount).toBe(2);
    expect(v.nextMilestone?.sprint).toBe(2);
    expect(v.amountToNext).toBe(125000); // 420000 - 295000
  });

  it('returns no next milestone once the final target is reached', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 40000, asOf: null } }));
    expect(v.clearedCount).toBe(5);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNextLabel).toBe('—');
    expect(v.overallPct).toBe(100);
  });
});

describe('milestoneView — overall progress', () => {
  it('is 0% at the Sprint 0 balance and clamps below 0', () => {
    expect(milestoneView(makeState({ homeLoan: { balance: 544000, asOf: null } })).overallPct).toBe(0);
    // Above the start balance clamps to 0 rather than going negative.
    expect(milestoneView(makeState({ homeLoan: { balance: 600000, asOf: null } })).overallPct).toBe(0);
  });

  it('is 100% at the final target', () => {
    expect(milestoneView(makeState({ homeLoan: { balance: 55000, asOf: null } })).overallPct).toBe(100);
  });
});

describe('milestoneView — schedule verdict (ahead / behind / on track)', () => {
  it('reads the planned balance flat before Sprint 0', () => {
    const state = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });
    const early = onDate('2026-01-01'); // before Sprint 0 (2026-06-18) -> expected 544000
    expect(milestoneView(state(544000), early).schedule).toMatchObject({ onTrack: true, expectedBalance: 544000 });
    expect(milestoneView(state(500000), early).schedule).toMatchObject({ ahead: true });
    expect(milestoneView(state(600000), early).schedule).toMatchObject({ ahead: false });
  });

  it('reads the planned balance exactly on a Sprint anchor date', () => {
    const state = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });
    const s1 = onDate('2027-03-18'); // Sprint 1 -> expected 420000
    expect(milestoneView(state(420000), s1).schedule?.expectedBalance).toBe(420000);
    expect(milestoneView(state(400000), s1).schedule).toMatchObject({ ahead: true });
    const behind = milestoneView(state(450000), s1).schedule!;
    expect(behind.ahead).toBe(false);
    expect(behind.deltaAmount).toBe(30000);
    expect(behind.label).toBe('$30,000 behind schedule');
  });

  it('interpolates strictly between two anchors', () => {
    // Between Sprint 0 (544k @ 2026-06-18) and Sprint 1 (420k @ 2027-03-18) the
    // expected balance sits strictly inside (420k, 544k).
    const mid = milestoneView(makeState({ homeLoan: { balance: 500000, asOf: null } }), onDate('2026-10-01')).schedule!;
    expect(mid.expectedBalance).toBeGreaterThan(420000);
    expect(mid.expectedBalance).toBeLessThan(544000);
  });

  it('treats a balance within ~$100 of plan as on track', () => {
    const v = milestoneView(makeState({ homeLoan: { balance: 543950, asOf: null } }), onDate('2026-01-01'));
    expect(v.schedule).toMatchObject({ onTrack: true, label: 'On track with the plan' });
  });
});

// ===== WHIT-393 MILESTONE_BALANCE_MAX enforced client ceiling (folded from milestoneCapBoundary.logic.test.ts)
// WHIT-393 — [C1]-[C3] the client milestone balance cap is the number the client actually enforces.
// The new pytest twin guard (tests/lambda_api/test_milestone_cap_sync.py) compares the TEXT of
// `export const MILESTONE_BALANCE_MAX` in src/milestones.ts against the server's
// _MILESTONE_BALANCE_MAX. That proves the two DECLARATIONS agree — it cannot see whether the
// client validator still uses the declared value. Nothing else does either: the existing
// milestonesOrdering.logic.test.ts probes the cap with a hand-typed 1_000_000_001 and never
// imports the constant, so inlining a different literal at src/milestones.ts:91 (or turning the
// `>` into `>=`) would leave the whole suite — and the twin guard — green while the editor
// rejected balances the server accepts.
// The loan-facts twin has this cover already ([D7] server side, [G4]-[G6] client side); this is
// the missing half for milestones.

// One row: no neighbour, so only the per-row field checks can fire and the balance is the
// only thing under test.
const oneRow = (targetBalance: number) => [{ label: 'Step', targetBalance, targetDate: '2026-01-01' }];

describe('MILESTONE_BALANCE_MAX is the enforced client ceiling', () => {
  it('[C1] a target balance EXACTLY at the cap is accepted', () => {
    // The strict-`>` boundary. A `>=` regression, or an inlined lower literal, reddens here.
    expect(milestonesOrderingError(oneRow(MILESTONE_BALANCE_MAX))).toBeNull();
  });

  it('[C2] one dollar over the cap is rejected', () => {
    // Derived from the constant (not the hand-typed 1_000_000_001 elsewhere), so raising the
    // inlined literal above the declared cap reddens here rather than passing by luck.
    expect(milestonesOrderingError(oneRow(MILESTONE_BALANCE_MAX + 1))).toMatch(/target balance/i);
  });

  it('[C3] the cap is a positive safe integer, so the +1 probe is a real step', () => {
    // Past 2^53 `MAX + 1 === MAX`, which would make [C2] assert nothing. Pin the precondition
    // (same reasoning as the loan-facts suites' String() note) instead of leaving it to luck.
    expect(Number.isSafeInteger(MILESTONE_BALANCE_MAX)).toBe(true);
    expect(MILESTONE_BALANCE_MAX).toBeGreaterThan(0);
  });
});

// ===== WHIT-8 milestoneView schedule at/beyond final anchor + delta-0 edges (folded from milestoneEdges.logic.test.ts)
// Adversarial GAP tests for milestoneView (WHIT-8) — edges the implementer's
// milestone.logic.test.ts does not lock: the schedule curve AT/BEYOND the final
// Sprint 4 anchor (the "flat after last" branch of expectedBalanceAt), the
// delta==0 boundary (must be onTrack AND ahead:false, guarding `delta > 0` vs
// `>=`), and the "already past the final target but before its date" combo
// (overallPct pinned 100 while genuinely ahead, no next milestone).
// Pure over s.homeLoan + MILESTONES + injected `today`; no provider/network.
// (onDate is reused from the survivor above — identical value; the sibling's own duplicate is dropped.)
const withBalance = (balance: number) => makeState({ homeLoan: { balance, asOf: null } });

const FINAL = MILESTONES[MILESTONES.length - 1];       // Sprint 4: 55000 @ 2029-06-18

describe('milestoneView — schedule at and beyond the final anchor', () => {
  it('holds the planned balance flat AT the final Sprint date (delta 0 => on track)', () => {
    // On the last anchor the expected balance is exactly the final target. A
    // balance equal to it is delta 0: on track, and explicitly NOT "ahead".
    const v = milestoneView(withBalance(FINAL.targetBalance), onDate(FINAL.targetDate)).schedule!;
    expect(v.expectedBalance).toBe(FINAL.targetBalance);   // 55000
    expect(v.deltaAmount).toBe(0);
    expect(v.onTrack).toBe(true);
    expect(v.ahead).toBe(false);                            // guards `delta > 0`, not `>=`
    expect(v.label).toBe('On track with the plan');
  });

  it('keeps the planned balance flat BEYOND the final Sprint date (no extrapolation)', () => {
    // Well past 2029-06-18 the curve must not keep dropping below 55000; it clamps.
    const v = milestoneView(withBalance(FINAL.targetBalance), onDate('2035-01-01')).schedule!;
    expect(v.expectedBalance).toBe(FINAL.targetBalance);   // still 55000, not < 0
    expect(v.onTrack).toBe(true);
  });
});

describe('milestoneView — delta 0 boundary before Sprint 0', () => {
  it('a balance exactly on the flat pre-Sprint-0 plan is on track, not ahead', () => {
    // Before the first anchor the expected balance is the Sprint 0 target.
    const start = MILESTONES[0].targetBalance;             // 544000
    const v = milestoneView(withBalance(start), onDate('2026-01-01')).schedule!;
    expect(v.expectedBalance).toBe(start);
    expect(v.deltaAmount).toBe(0);
    expect(v.ahead).toBe(false);
    expect(v.onTrack).toBe(true);
    expect(v.label).toBe('On track with the plan');
  });
});

describe('milestoneView — under the final target before its date', () => {
  it('caps overallPct at 100 while reporting genuinely ahead and no next milestone', () => {
    // Balance already below the Sprint 4 target, but "today" sits between Sprint 0
    // and Sprint 1 so the plan still expects a high balance => far ahead.
    const v = milestoneView(withBalance(40000), onDate('2027-01-01'));
    expect(v.overallPct).toBe(100);           // clamped, never > 100
    expect(v.clearedCount).toBe(5);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNextLabel).toBe('—');    // no next => em dash, not "$0"
    expect(v.schedule!.ahead).toBe(true);
    expect(v.schedule!.onTrack).toBe(false);
    expect(v.schedule!.label).toMatch(/ahead of schedule$/);
  });
});

// ===== WHIT-377 milestonesOrderingError + milestoneOutOfOrderRows (folded from milestonesOrdering.logic.test.ts)
// WHIT-377 — milestonesOrderingError + milestoneOutOfOrderRows: the pure client guard that mirrors
// the server's set_milestones contract (lambda_api/handler.py:2073-2142), so the editor blocks a
// bad plan before any round-trip. This is the fail-on-revert anchor for the ordering rule.

type Row = { label: string; targetBalance: number; targetDate: string };

// A valid, strictly paid-down plan (decreasing balance, increasing date).
const VALID: Row[] = [
  { label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

describe('milestonesOrderingError — accepts valid plans', () => {
  it('returns null for a strictly paid-down multi-row plan', () => {
    expect(milestonesOrderingError(VALID)).toBeNull();
  });

  it('returns null for a single-row plan (no pair to compare)', () => {
    expect(milestonesOrderingError([{ label: 'Only', targetBalance: 300000, targetDate: '2026-01-01' }])).toBeNull();
  });

  it('allows a final target balance of exactly 0 (loan fully paid)', () => {
    expect(milestonesOrderingError([
      { label: 'Start', targetBalance: 100000, targetDate: '2026-01-01' },
      { label: 'Done',  targetBalance: 0,      targetDate: '2027-01-01' },
    ])).toBeNull();
  });
});

describe('milestonesOrderingError — list-level limits', () => {
  it('rejects an empty list', () => {
    expect(milestonesOrderingError([])).toMatch(/at least one/i);
  });

  it('rejects more than the max number of rows', () => {
    const many: Row[] = Array.from({ length: MILESTONE_MAX_COUNT + 1 }, (_, i) => ({
      label: `Step ${i}`, targetBalance: 1_000_000 - i, targetDate: isoForIndex(i),
    }));
    expect(milestonesOrderingError(many)).toMatch(new RegExp(`at most ${MILESTONE_MAX_COUNT}`));
  });
});

describe('milestonesOrderingError — per-row field checks', () => {
  it('rejects a blank label', () => {
    expect(milestonesOrderingError([{ label: '   ', targetBalance: 100000, targetDate: '2026-01-01' }])).toMatch(/name/i);
  });

  it('rejects a label longer than the max length', () => {
    expect(milestonesOrderingError([{ label: 'x'.repeat(MILESTONE_LABEL_MAX_LEN + 1), targetBalance: 100000, targetDate: '2026-01-01' }])).toMatch(/at most/i);
  });

  it.each([
    ['NaN (blank/partial input)', NaN],
    ['negative', -1],
    ['above the max', 1_000_000_001],
  ])('rejects a target balance that is %s', (_label, bad) => {
    expect(milestonesOrderingError([{ label: 'Step', targetBalance: bad, targetDate: '2026-01-01' }])).toMatch(/target balance/i);
  });

  it.each([
    ['unset', ''],
    ['not a date', 'someday'],
    ['impossible calendar date', '2026-02-30'],
    ['out-of-range month', '2026-13-01'],
  ])('rejects a target date that is %s', (_label, bad) => {
    expect(milestonesOrderingError([{ label: 'Step', targetBalance: 100000, targetDate: bad }])).toMatch(/target date/i);
  });
});

describe('milestonesOrderingError — the ordering rule', () => {
  it.each([
    ['a rising balance', [VALID[0], { label: 'Up', targetBalance: 400000, targetDate: '2027-01-01' }]],
    ['an equal balance', [VALID[0], { label: 'Same', targetBalance: 300000, targetDate: '2027-01-01' }]],
    ['an earlier date', [VALID[0], { label: 'Back', targetBalance: 200000, targetDate: '2025-01-01' }]],
    ['an equal date',   [VALID[0], { label: 'SameDay', targetBalance: 200000, targetDate: '2026-01-01' }]],
  ])('rejects %s between neighbours', (_label, rows) => {
    expect(milestonesOrderingError(rows as Row[])).toMatch(/lower balance and a later date/i);
  });
});

describe('milestoneOutOfOrderRows — per-row flags for the live warning', () => {
  it('flags no rows for a valid plan', () => {
    expect(milestoneOutOfOrderRows(VALID)).toEqual([false, false, false]);
  });

  it('never flags the first row (nothing above it)', () => {
    const rising = [{ label: 'A', targetBalance: 100000, targetDate: '2026-01-01' }, { label: 'B', targetBalance: 200000, targetDate: '2027-01-01' }];
    expect(milestoneOutOfOrderRows(rising)[0]).toBe(false);
  });

  it('flags exactly the row that breaks the order', () => {
    // Row 1 (index 1) rises in balance → flagged; rows 0 and 2 are fine relative to their predecessor.
    const rows = [
      { label: 'A', targetBalance: 300000, targetDate: '2026-01-01' },
      { label: 'B', targetBalance: 400000, targetDate: '2027-01-01' }, // rises → out of order
      { label: 'C', targetBalance: 100000, targetDate: '2028-01-01' },
    ];
    expect(milestoneOutOfOrderRows(rows)).toEqual([false, true, false]);
  });
});

// Distinct, increasing ISO dates for the >50 fixture.
function isoForIndex(i: number): string {
  const year = 2026 + i;
  return `${year}-01-01`;
}

// ===== WHIT-367 milestoneView saved-plan read path (folded from milestone.readpath.logic.test.ts)
// Logic tests for the milestone read path (WHIT-367): milestoneView now reads the
// user's SAVED milestone plan (falling back to the built-in default when none is
// saved) instead of the hardcoded MILESTONES constant. Pure over the injected list —
// no provider/network. The saved MilestoneRecord shape has no `sprint`, so the step
// number is derived from list position.
// (onDate is reused from the survivor above — identical value; the sibling's own duplicate is dropped.)

// A custom saved plan, deliberately different from the built-in default so the read
// path is observable: three steps, still strictly paid-down (decreasing balance, later
// dates). No `sprint` field — that's the whole point of MilestoneRecord.
const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',   targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway',  targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff',  targetBalance: 100000, targetDate: '2028-01-01' },
];

describe('milestoneView — reads the saved plan (WHIT-367)', () => {
  it('drives rows/next/progress off the injected saved list, not the default', () => {
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } }));
    // Three saved rows, not the default's five.
    expect(v.rows).toHaveLength(3);
    expect(v.rows.map((r) => r.label)).toEqual(['Start', 'Midway', 'Payoff']);
    expect(v.total).toBe(3);
    // 250k clears 'Start' (300k), next is 'Midway' (200k).
    expect(v.clearedCount).toBe(1);
    expect(v.nextMilestone?.label).toBe('Midway');
    expect(v.amountToNext).toBe(50000); // 250000 - 200000
    // overallPct runs from the saved start (300k) down to the saved end (100k):
    // (300000 - 250000) / (300000 - 100000) = 25%.
    expect(v.overallPct).toBe(25);
  });

  it('derives the step number from list position (saved rows carry no sprint)', () => {
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } }));
    // The load-bearing line: sprint = array index, so the display "Sprint N" + React key
    // survive a MilestoneRecord that has no stored sprint.
    expect(v.rows.map((r) => r.sprint)).toEqual([0, 1, 2]);
  });

  it('interpolates the schedule between the saved anchors, not the default ones', () => {
    // Halfway (in time) between 'Start' (300k @ 2026-01-01) and 'Midway' (200k @ 2027-01-01)
    // the planned balance sits strictly inside (200k, 300k) — a default-plan curve would
    // give a different number, so this proves the injected anchors drive it.
    const s = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 260000, asOf: null } }), onDate('2026-07-01'));
    expect(s.schedule!.expectedBalance).toBeGreaterThan(200000);
    expect(s.schedule!.expectedBalance).toBeLessThan(300000);
  });
});

describe('milestoneView — empty when the user has no saved plan', () => {
  it('an empty saved list yields an empty view (hasPlan false), not a default plan', () => {
    // Fail-on-revert for removing the hardcoded default: an empty plan must NOT resurrect the
    // built-in MILESTONES — the screens show a "set your milestones" prompt instead.
    const v = milestoneView(makeState({ milestones: [], homeLoan: { balance: 420000, asOf: null } }));
    expect(v.hasPlan).toBe(false);
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.nextMilestone).toBeNull();
    expect(v.schedule).toBeNull();
    expect(v.overallPct).toBe(0);
  });
});

// ===== WHIT-367 (folded from milestoneReadpathGaps.logic.test.ts) — adversarial edges of the
// milestoneView saved-plan read path the survivor doesn't lock: overallPct clamp at BOTH ends over
// the SAVED anchors (not the default), and a single-row saved plan (plan[0] === plan[len-1] access)
// not throwing / not NaN-ing when the balance is below the lone target. onDate and SAVED_PLAN are
// reused from the survivor above (identical values; the gaps file's own duplicates are dropped).
describe('milestoneView — overallPct clamps over the SAVED anchors (WHIT-367)', () => {
  it('clamps to 100 when the balance is below the saved final target (all cleared)', () => {
    // 50k < 100k (saved end) → raw pct 125 → clamped to 100. A clamp using the DEFAULT plan's
    // 55k end would give a different raw number, so the saved anchors are load-bearing here.
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 50000, asOf: null } }));
    expect(v.overallPct).toBe(100);
    expect(v.clearedCount).toBe(3);
    expect(v.nextMilestone).toBeNull();
    expect(v.amountToNext).toBe(0);
  });

  it('clamps to 0 when the balance is above the saved first target (nothing cleared)', () => {
    // 350k > 300k (saved start) → raw pct -25 → clamped to 0. Next is the saved first row.
    const v = milestoneView(makeState({ milestones: SAVED_PLAN, homeLoan: { balance: 350000, asOf: null } }));
    expect(v.overallPct).toBe(0);
    expect(v.clearedCount).toBe(0);
    expect(v.nextMilestone?.label).toBe('Start');
    expect(v.amountToNext).toBe(50000); // 350000 - 300000
  });
});

describe('milestoneView — a single-row saved plan (plan[0] === plan[len-1])', () => {
  // The read path indexes plan[0] and plan[plan.length-1]. With one saved row those are the
  // SAME element; below-target must still produce a finite, non-NaN view (not a crash), proving
  // the length-1 access is safe for the common "one milestone left" saved list.
  const SINGLE: MilestoneRecord[] = [
    { id: 'only', label: 'Only', targetBalance: 300000, targetDate: '2026-01-01' },
  ];

  it('renders one row keyed 0 and a finite view when the balance is below the lone target', () => {
    const v = milestoneView(makeState({ milestones: SINGLE, homeLoan: { balance: 250000, asOf: null } }), onDate('2026-07-01'));
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].sprint).toBe(0);
    expect(v.total).toBe(1);
    expect(v.clearedCount).toBe(1);        // 250k <= 300k
    expect(v.nextMilestone).toBeNull();    // the only target is cleared
    // start === end (300k) → zero span; the overallProgressPct guard returns 100 when the
    // balance is at or below the lone target, NOT NaN from a 0/0 division.
    expect(Number.isNaN(v.overallPct)).toBe(false);
    expect(v.overallPct).toBe(100);
    // schedule is flat before/after the single anchor — expectedBalance is the lone target,
    // never NaN from a zero-width interpolation segment.
    expect(v.schedule).not.toBeNull();
    expect(v.schedule!.expectedBalance).toBe(300000);
    expect(Number.isNaN(v.schedule!.deltaAmount)).toBe(false);
  });

  it('does NOT NaN when the balance sits EXACTLY on the lone target (the degenerate 0/0 edge)', () => {
    // This is the case the guard exists for: balance === start === end would be 0/0 → NaN without
    // the start===end short-circuit. Balance at the target counts as cleared → fully done (100).
    const v = milestoneView(makeState({ milestones: SINGLE, homeLoan: { balance: 300000, asOf: null } }));
    expect(Number.isNaN(v.overallPct)).toBe(false);
    expect(v.overallPct).toBe(100);
    expect(v.clearedCount).toBe(1);
  });
});
