// WHIT-69 (adversarial half, authored by qa) — income earn-target boundaries the
// implementer's budget.logic.test.ts doesn't lock: exactly-at-floor, exactly-on-pace,
// pending-only earnings, and postedPct/pendingPct bar-segment capping in budgetViews
// and budgetDetail. All assert against the real exported selectors, so reverting the
// income branch fails them.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget } from './factory';

const RED = '#ff6b6b';
// Income category; colour deliberately NOT red so "colour is not red" tests can't
// pass by accident on the category colour.
const income = () => cat({ id: 'salary', name: 'Salary', color: '#7c8cff', bucket: 'Income' });

// elapsed = (14 - 7)/14 = 0.5 → linear target = budget * 0.5 = 2500 for a 5000 floor.
const viewState = (posted: number, pending = 0) => makeState({
  categories: [income()],
  budgets: [budget({ id: 'salary', budget: 5000, posted, pending })],
  cycleLen: 14, daysLeft: 7,
});

describe('budgetViews — income earn-target boundaries (WHIT-69)', () => {
  it('earned EXACTLY at the floor → met, "over target", remain $0, green, not red', () => {
    const row = budgetViews(viewState(5000)).rows[0];
    expect(row.remainLabel).toBe('over target');
    expect(row.remainAmount).toBe('$0');           // actual - budget = 0
    expect(row.remainColor).toBe('#35d9a0');
    expect(row.paceLabel).toBe('$0 over target');
    expect(row.over).toBe(false);
    expect(row.postedColor).not.toBe(RED);
  });

  it('earned EXACTLY on the linear pace → calm green "on pace", still "to go"', () => {
    const row = budgetViews(viewState(2500)).rows[0]; // 2500 == elapsed*budget, < floor
    expect(row.paceLabel).toBe('on pace');
    expect(row.paceColor).toBe('#35d9a0');
    expect(row.remainLabel).toBe('to go');
    expect(row.remainColor).toBe('#cfd2ff');
    expect(row.remainAmount).toBe('$2,500');        // 5000 - 2500 still to earn
    expect(row.over).toBe(false);
  });

  it('ONLY pending earnings ($0 posted) → ahead-of-pace from pending, "(… pending)" label', () => {
    const row = budgetViews(viewState(0, 3000)).rows[0]; // actual 3000 > pace 2500
    expect(row.spentLabel).toBe('$3,000 earned ($3,000 pending) of $5,000');
    expect(row.paceLabel).toContain('ahead of pace');
    expect(row.postedPct).toBe(0);                  // nothing posted yet
    expect(row.pendingPct).toBe(60);                // 3000/5000 = 60%, not capped here
    expect(row.remainColor).not.toBe(RED);
    expect(row.over).toBe(false);
  });

  it('bar segments never exceed 100% — pendingPct is capped at 100 - postedPct', () => {
    // posted 4000 (80%) + pending 2000 (raw 40%) → capped to 20% so the bar sums to 100.
    const row = budgetViews(viewState(4000, 2000)).rows[0];
    expect(row.postedPct).toBe(80);
    expect(row.pendingPct).toBe(20);                // min(40, 100-80), NOT 40
    expect(row.postedPct + row.pendingPct).toBeLessThanOrEqual(100);
    expect(row.remainLabel).toBe('over target');    // 6000 >= 5000 floor
  });
});

describe('budgetDetail — income earn-target with pending (WHIT-69)', () => {
  const detail = (posted: number, pending = 0) => budgetDetail(makeState({
    categories: [income()],
    budgets: [budget({ id: 'salary', budget: 5000, posted, pending })],
    cycleLen: 14, daysLeft: 7,
  }), 'salary')!;

  it('under target with pending → perDay-to-target uses the shortfall, pendingPct not capped', () => {
    const d = detail(1000, 500);                    // actual 1500, toGo 3500, 7 days left
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).toBe('#cfd2ff');
    expect(d.dailyLabel).toBe('$500/day to target'); // 3500 / max(1,7) = 500
    expect(d.postedPct).toBe(20);
    expect(d.pendingPct).toBe(10);                   // 500/5000, under the cap
  });

  it('target reached via posted+pending → capped pendingPct, "Target reached"', () => {
    const d = detail(4000, 2000);                    // actual 6000 >= 5000
    expect(d.statusLabel).toBe('Target reached — nice');
    expect(d.statusColor).toBe('#35d9a0');
    expect(d.dailyLabel).toBe('Target reached');
    expect(d.postedPct).toBe(80);
    expect(d.pendingPct).toBe(20);                   // min(40, 100-80)
  });
});
