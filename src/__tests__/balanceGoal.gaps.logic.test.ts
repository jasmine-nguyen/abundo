// WHIT-232 — balanceGoal ADVERSARIAL GAPS (independent of the 20 implementer tests in
// balanceGoal.logic.test.ts). Covers: more paydaysUntil phases/lengths + autumn DST +
// leap day; the full 4-cell direction×source sign matrix incl. grow-manual & the
// account_id+manual_balance XOR-violation; progress clamps below 0 / defensive baselines;
// NaN/Infinity balance guards; garbage target_date through balanceGoalView. Every expected
// is hand-counted (brute-enumerated in a scratch node run) and reasoned in Melbourne TZ
// (runner pins TZ=Australia/Melbourne). [IDs] map to the Part-1 checklist.
import { describe, it, expect } from '@jest/globals';
import { paydaysUntil, balanceGoalView, BalanceGoal } from '../context';

const CYCLE = { length: 14, last_pay_date: '2026-06-06' }; // paydays ...Jul4, Jul18, Aug1, Aug15
const TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026, Melbourne local midnight

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}

// --- paydaysUntil: more phases, lengths, boundaries ------------------------
describe('paydaysUntil — phases/lengths/boundaries', () => {
  const W = { length: 7, last_pay_date: '2026-07-01' };  // weekly: Jul1,8,15,22,29,Aug5...
  const M = { length: 30, last_pay_date: '2026-01-15' }; // ~monthly

  it('[A20] weekly (len 7): (Jul11, Aug1] -> Jul15,22,29 = 3', () => {
    expect(paydaysUntil(W, '2026-08-01', TODAY)).toBe(3);
  });

  it('[A21] weekly far-future target one year out -> 51 (large count stays exact)', () => {
    // pay Jul1; paydays at day 0,7,..,364; window (day10, day365] -> n=2..52 = 51.
    expect(paydaysUntil(W, '2027-07-01', TODAY)).toBe(51);
  });

  it('[A22] ~monthly (len 30): (Jul11, Aug15] -> 2 paydays (Jul14, Aug13)', () => {
    expect(paydaysUntil(M, '2026-08-15', TODAY)).toBe(2);
  });

  it('[A23] target BEFORE last_pay_date -> 0 (no negative count)', () => {
    expect(paydaysUntil(W, '2026-06-20', TODAY)).toBe(0);
  });

  it('[A24] target == today, and today IS a payday -> 0 (half-open excludes both ends here)', () => {
    // today = Jul8 (a weekly payday); window (Jul8, Jul8] is empty.
    expect(paydaysUntil(W, '2026-07-08', new Date(2026, 6, 8))).toBe(0);
  });

  it('[A25] today far BEFORE last_pay_date (backward-filled paydays) -> 17', () => {
    // pay Aug1 len14; (Jan1, Aug15] enumerates 17 fortnightly paydays.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-08-01' }, '2026-08-15', new Date(2026, 0, 1))).toBe(17);
  });

  it('[A26] DST autumn fall-back (Melbourne, Sun 5 Apr 2026) does not shift the count', () => {
    // pay=today=Mar22, target=Apr19 spans the fall-back; (Mar22, Apr19] -> Apr5, Apr19 = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-03-22' }, '2026-04-19', new Date(2026, 2, 22))).toBe(2);
  });

  it('[A27] leap-day target (29 Feb 2028) counts correctly', () => {
    // pay Feb1 2028 len14 -> Feb1,15,29; (Feb1, Feb29] -> Feb15, Feb29 = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2028-02-01' }, '2028-02-29', new Date(2028, 1, 1))).toBe(2);
  });

  it('[A28] leap-day last_pay_date (29 Feb 2028) as the anchor counts correctly', () => {
    // pay=today=Feb29; (Feb29, Mar14] -> Mar14 = 1.
    expect(paydaysUntil({ length: 14, last_pay_date: '2028-02-29' }, '2028-03-14', new Date(2028, 1, 29))).toBe(1);
  });
});

// --- Sign matrix: 4 cells (direction × source) + XOR oddity + zeros --------
describe('balanceGoalView — sign/source matrix', () => {
  it('[A30] grow-MANUAL: reads goal.manual_balance (not the null balance input)', () => {
    // account_id null -> manual source; manual_balance 4000 / target 10000 = 0.4.
    const v = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: 4000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(v.progress).toBeCloseTo(0.4, 10);
    expect(v.pacePerPayday).toBe(2000); // 6000 / 3
  });

  it('[A31] account_id AND manual_balance both set (XOR violation): synced WINS, reads balance', () => {
    // manual_balance 999 must be IGNORED because account_id is present. progress uses 4000.
    const v = balanceGoalView({ goal: goal({ manual_balance: 999 }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(0.4, 10); // 4000/10000, NOT 999/10000 = 0.0999
  });

  it('[A32] synced GROW balance exactly 0 -> valid 0 savings (progress 0, a number)', () => {
    const v = balanceGoalView({ goal: goal(), balance: 0, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
    expect(v.pacePerPayday).toBe(10000 / 3);
  });

  it('[A33] synced PAYDOWN balance exactly 0 -> owed 0 -> met (progress 1, pace 0)', () => {
    const v = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000 }), balance: 0, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(1);
    expect(v.pacePerPayday).toBe(0);
  });

  it('[A34] manual_balance exactly 0 (grow) -> progress 0, (paydown) -> met 1', () => {
    const grow = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: 0, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(grow.progress).toBe(0);
    const pay = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000, account_id: null, manual_balance: 0, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(pay.progress).toBe(1);
  });

  it('[A35] NaN / Infinity synced balance is guarded to null (unknown), paydays still count', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = balanceGoalView({ goal: goal(), balance: bad, payCycle: CYCLE }, TODAY);
      expect(v.progress).toBeNull();
      expect(v.pacePerPayday).toBeNull();
      expect(v.paydaysLeft).toBe(3);
    }
  });

  it('[A36] NaN manual_balance is guarded to null (unknown)', () => {
    const v = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: NaN, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeNull();
    expect(v.pacePerPayday).toBeNull();
  });
});

// --- Progress boundary clamps ----------------------------------------------
describe('balanceGoalView — progress clamps', () => {
  it('[A40] paydown debt GREW past baseline (owed > baseline) clamps to 0, never negative', () => {
    // synced -25000 -> owed 25000; (20000-25000)/20000 = -0.25 -> clamp 0. pace = 25000/3.
    const v = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000 }), balance: -25000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
    expect(v.pacePerPayday).toBeCloseTo(25000 / 3, 6);
  });

  it('[A41] grow current == baseline is progress 0 (a number), not null', () => {
    const v = balanceGoalView({ goal: goal({ baseline: 2000 }), balance: 2000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
  });

  it('[A42] defensive negative baseline (grow) still yields finite in-range progress', () => {
    // baseline -1000, target 10000, bal 4000 -> (4000+1000)/11000 = 0.4545..., finite.
    const v = balanceGoalView({ goal: goal({ baseline: -1000 }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(5000 / 11000, 10);
    expect(Number.isFinite(v.progress as number)).toBe(true);
  });
});

// --- pace × paydaysLeft edges through balanceGoalView -----------------------
describe('balanceGoalView — pace/paydaysLeft', () => {
  it('[A43] garbage target_date -> paydaysLeft 0 -> pace = whole remaining (no crash/NaN)', () => {
    const v = balanceGoalView({ goal: goal({ target_date: 'not-a-date' }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.paydaysLeft).toBe(0);
    expect(v.pacePerPayday).toBe(6000); // remaining, not remaining/0
    expect(Number.isFinite(v.pacePerPayday as number)).toBe(true);
  });
});
