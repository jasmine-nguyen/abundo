// incomeBreakdown selector (WHIT-373): shapes the per-source income map into rows for the Insights
// "Earning" toggle. Pure over { incomeSources, earned, category }, ported from the retired
// /breakdown earned branch — so this locks the taxonomy join, the reversed-source flag, and the
// RECONCILE_EPSILON reconcile plug that keeps the rows summing to the `earned` headline (the same
// boundary the deleted breakdownEarnedPlugEpsilon.screen.test.tsx used to cover through a render).
import { describe, it, expect } from '@jest/globals';
import { incomeBreakdown } from '../context';
import { C } from '../theme';
import { cat } from './factory';
import type { Category } from '../context';

function lookup(cats: Category[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
}

const CATS = [
  cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de' }),
  cat({ id: 'dividends', name: 'Dividends', bucket: 'Income', icon: 'trend', color: '#9ece6a' }),
];

describe('incomeBreakdown', () => {
  it('joins each source to the taxonomy for its name/icon/colour, preserving input order', () => {
    const { rows } = incomeBreakdown({
      earned: 3500,
      incomeSources: [
        { id: 'salary', posted: 3000, pending: 0, amount: 3000 },
        { id: 'dividends', posted: 500, pending: 0, amount: 500 },
      ],
      category: lookup(CATS),
    });
    expect(rows.map((r) => r.name)).toEqual(['Salary', 'Dividends']);   // biggest-first order kept
    expect(rows[0]).toMatchObject({ id: 'salary', icon: 'briefcase', color: '#2ac3de', amount: 3000, drillId: 'salary', reversed: false, muted: false });
    expect(rows.filter((r) => !r.muted)).toHaveLength(2);
  });

  it('falls back to Income / briefcase / good colour when the taxonomy lacks the id', () => {
    const { rows } = incomeBreakdown({
      earned: 200,
      incomeSources: [{ id: 'mystery', posted: 200, pending: 0, amount: 200 }],
      category: () => undefined,
    });
    expect(rows[0]).toMatchObject({ name: 'Income', icon: 'briefcase', color: C.good });
  });

  it('flags a clawed-back source (negative net) as reversed', () => {
    const { rows } = incomeBreakdown({
      earned: 2900,
      incomeSources: [
        { id: 'salary', posted: 3000, pending: 0, amount: 3000 },
        { id: 'dividends', posted: -100, pending: 0, amount: -100 },
      ],
      category: lookup(CATS),
    });
    expect(rows.find((r) => r.id === 'salary')?.reversed).toBe(false);
    expect(rows.find((r) => r.id === 'dividends')?.reversed).toBe(true);
  });

  it('carries pending through per source', () => {
    const { rows } = incomeBreakdown({
      earned: 500,
      incomeSources: [{ id: 'salary', posted: 300, pending: 200, amount: 500 }],
      category: lookup(CATS),
    });
    expect(rows[0].pending).toBe(200);
  });

  it('appends one muted plug so the rows sum to earned when a residual is left', () => {
    // sources shown = 3000; earned = 3120 ⇒ residual 120 (a clamped-away pending/refund bucket).
    const { rows } = incomeBreakdown({
      earned: 3120,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
      category: lookup(CATS),
    });
    const plug = rows.find((r) => r.muted);
    expect(plug).toMatchObject({ name: 'Pending/refund adjustment', amount: 120, muted: true });
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBeCloseTo(3120, 6); // rows reconcile to earned
    expect(rows.filter((r) => !r.muted)).toHaveLength(1); // the plug is not counted as a source
  });

  it('SUPPRESSES the plug when the residual is float dust below the half-cent tolerance', () => {
    // source nets 9.996; earned = 10 ⇒ residual ≈ 0.004 (< RECONCILE_EPSILON). No phantom plug.
    // FAIL-ON-REVERT: change the guard to `> 0` and this case grows a plug.
    const { rows } = incomeBreakdown({
      earned: 10,
      incomeSources: [{ id: 'salary', posted: 9.996, pending: 0, amount: 9.996 }],
      category: lookup(CATS),
    });
    expect(rows.some((r) => r.muted)).toBe(false);
    expect(rows.filter((r) => !r.muted)).toHaveLength(1);
  });

  it('APPENDS the plug when the residual is just over the half-cent tolerance', () => {
    // source nets 9.994; earned = 10 ⇒ residual ≈ 0.006 (>= RECONCILE_EPSILON). One plug closes it.
    const { rows } = incomeBreakdown({
      earned: 10,
      incomeSources: [{ id: 'salary', posted: 9.994, pending: 0, amount: 9.994 }],
      category: lookup(CATS),
    });
    expect(rows.some((r) => r.muted)).toBe(true);
  });

  it('never synthesises a lone plug when there are no sources (old server: earned but no map)', () => {
    const { rows } = incomeBreakdown({ earned: 3000, incomeSources: [], category: lookup(CATS) });
    expect(rows).toEqual([]);
  });
});
