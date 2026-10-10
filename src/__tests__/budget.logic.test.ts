// Budget selectors: elapsedFrac, budgetViews (the list bars + pace copy) and
// budgetDetail (the single-category screen). These drive every number and colour
// on the budgets screens, so they're the highest-value regression lock.
import { describe, it, expect, jest } from '@jest/globals';
import { budgetViews, budgetDetail, groupTransactionsByDate } from '../context';
import type { BudgetDetailInput } from '../context';
import { elapsedFrac } from '../payCycle';
import { pacePct, paceTarget } from '../budgetMath';
import type { Budget } from '../model';
import type { Transaction } from '../types';
import { C, tint, MINUS } from '../theme';
import { makeState, cat, budget, txn } from './factory';
import { budgetDetailFor as detail, budgetRowFor, budgetRowsFor } from './support/budgetsTab';
import { SALARY } from './support/categories';

describe('elapsedFrac', () => {
  it('is (cycleLen - daysLeft) / cycleLen', () => {
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 7 }))).toBeCloseTo(0.5, 5);
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 14 }))).toBe(0); // fresh cycle
    expect(elapsedFrac(makeState({ cycleLen: 14, daysLeft: 0 }))).toBe(1);  // cycle ended
  });
});

describe('budgetViews', () => {
  const base = () => makeState({
    categories: [cat()],
    cycleLen: 14, daysLeft: 7, // elapsed = 0.5
  });

  it('sums posted + pending as spend and computes remaining', () => {
    const s = makeState({ ...{}, categories: [cat()], budgets: [budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(totBudget).toBe(100);
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
    expect(rows).toHaveLength(1);
  });

  it('splits the bar into posted% and pending% within the budget', () => {
    const s = makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 });
    const [row] = budgetViews(s).rows;
    expect(row.postedPct).toBeCloseTo(40, 5);
    expect(row.pendingPct).toBeCloseTo(10, 5);
    expect(row.over).toBe(false);
  });

  it('caps the pending segment so posted% + pending% never exceeds 100', () => {
    // posted 90 + pending 40 = 130 of 100 → over budget; bars must still sum to <= 100.
    const s = makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 90, pending: 40 })], cycleLen: 14, daysLeft: 7 });
    const [row] = budgetViews(s).rows;
    expect(row.over).toBe(true);
    expect(row.postedPct + row.pendingPct).toBeLessThanOrEqual(100.0001);
  });

  it('spending past the linear target (elapsed * budget) is not over budget', () => {
    // elapsed 0.5, budget 100 → target 50.
    const over = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 80, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(over.over).toBe(false); // over PACE, not over budget
  });

  it('skips a budget whose category no longer exists', () => {
    const s = makeState({ categories: [cat()], budgets: [budget({ id: 'ghost', budget: 50, posted: 0, pending: 0 })], cycleLen: 14, daysLeft: 7 });
    expect(budgetViews(s).rows).toHaveLength(0);
  });

  it('shows exact cents on a fractional spent + left so the list row matches the detail and reconciles to the budget', () => {
    // posted 62.50 + pending 11.00 = 73.50 spent of $80 → 6.50 left (the Cafes & Coffee case).
    const row = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 80, posted: 62.5, pending: 11 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.spentLabel).toBe('$73.50 of\u00a0$80'); // fail-on-revert: fmt(73.5) → '$74'
    expect(row.remainAmount).toBe('$6.50');             // spent + left = the $80 budget
  });

  it('sums pending across top-level spending rows only — not Income, Savings or a nested budgeted sub', () => {
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
        cat(),
        cat({ id: 'salary', name: 'Salary', bucket: 'Income' }),
        cat({ id: 'rainy', name: 'Rainy Day', bucket: 'Savings' }),
      ],
      budgets: [
        budget({ id: 'car', budget: 200, posted: 60, pending: 15 }),
        budget({ id: 'parking', budget: 50, posted: 20, pending: 10 }),
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 5.25 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 300 }),
        budget({ id: 'rainy', budget: 300, posted: 100, pending: 70 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    expect(budgetViews(s).totPending).toBe(20.25);
  });

  it.each([
    ['6 days → weekday, not a date', 6, '2026-10-09', '$1,000 earned · next pay ~Fri'],
    ['7 days → "~10 Oct" (date, not weekday)', 7, '2026-10-10', '$1,000 earned · next pay ~10 Oct'],
    ['an empty nextPayday adds nothing', 6, '', '$1,000 earned'],
  ])('income next-pay label: %s', (_case, daysLeft, nextPayday, label) => {
    const row = budgetViews({
      ...makeState({ categories: [SALARY], budgets: [budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 })], cycleLen: 14, daysLeft }),
      nextPayday,
    }).rows[0];
    expect(row.spentLabel).toBe(label);
  });

  it('[A15] income family moves after all spend rows with nesting intact', () => {
    const { rows, totBudget, totSpent } = budgetViews(makeState({
      categories: [
        SALARY, cat({ id: 'bonus', name: 'Bonus', bucket: 'Income', parent: 'salary' }),
        cat(), cat({ id: 'latte', name: 'Lattes', bucket: 'Lifestyle', parent: 'coffee' }),
        cat({ id: 'rent', name: 'Rent', bucket: 'Living' }),
      ],
      budgets: [
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 0 }),
        budget({ id: 'bonus', budget: 500, posted: 0, pending: 0 }),
        budget({ id: 'latte', budget: 30, posted: 5, pending: 0 }),
        budget({ id: 'rent', budget: 1000, posted: 1000, pending: 0 }),
      ],
      cycleLen: 14, daysLeft: 7,
    }));
    expect(rows.map((r) => r.id)).toEqual(['coffee', 'latte', 'rent', 'salary', 'bonus']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0, 0, 1]);
    expect(rows.find((r) => r.id === 'bonus')!.parentId).toBe('salary');
    expect(rows.find((r) => r.id === 'bonus')!.section).toBe('earning');
    // Reordering doesn't change the hero totals: income still left out, sub not double-counted.
    expect(totBudget).toBe(1100);
    expect(totSpent).toBe(1040);
  });

  it('[A12] $99.50 budget reads "of $99.50", not "of $100"', () => {
    expect(budgetRowFor({ budget: 99.5, posted: 10, pending: 0 }).spentLabel).toBe('$10 of $99.50');
  });
});

// Halfway through a 14-day cycle, so a $100 budget's pace target is $50.
describe('budget rows and detail — today tick and slim rows', () => {
  it('under-budget rows keep the tick, over rows hide it, and $0 rows are unspent', () => {
    const overPlan = budgetRowFor({ budget: 100, posted: 85, pending: 0 });
    expect(overPlan.showTarget).toBe(true);
    expect(overPlan.unspent).toBe(false);

    expect(budgetRowFor({ budget: 100, posted: 20, pending: 0 }).showTarget).toBe(true);

    const overBudget = budgetRowFor({ budget: 100, posted: 130, pending: 0 });
    expect(overBudget.showTarget).toBe(false);
    expect(overBudget.unspent).toBe(false);

    expect(budgetRowFor({ budget: 100, posted: 0, pending: 0 }).unspent).toBe(true);
    expect(budgetRowFor({ budget: 100, posted: 0.01, pending: 0 }).unspent).toBe(false);
    // $41 target − $700 spread payback → a −$659 budget: $0 spent is still over, so not slim.
    const payback = budgetRowFor({
      budget: 41, posted: 0, pending: 0, spreadAdjustment: -700,
      spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 },
    });
    expect(payback.unspent).toBe(false);

    const income = budgetRowsFor([SALARY], [budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 })])[0];
    expect(income.unspent).toBe(false);
  });

  it('[A8] a pending-only charge counts as spent, so the row stays full', () => {
    expect(budgetRowFor({ budget: 100, posted: 0, pending: 5 }).unspent).toBe(false);
  });

  it('row and detail: tick only while something is left', () => {
    expect(budgetRowFor({ budget: 100, posted: 30, pending: 0 }).showTarget).toBe(true);
    expect(budgetRowFor({ budget: 100, posted: 100, pending: 0 }).showTarget).toBe(false);
    expect(budgetRowFor({ budget: 100, posted: 150, pending: 0 }).showTarget).toBe(false);
    expect(detail({ budget: 100, posted: 30 }).showTarget).toBe(true);
    expect(detail({ budget: 100, posted: 100 }).showTarget).toBe(false);
    expect(detail({ budget: 100, posted: 150 }).showTarget).toBe(false);
  });

  it('[A4] rollover row past its target but inside its leftovers keeps the tick', () => {
    const row = budgetRowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 50 });
    expect(row.showTarget).toBe(true);
    expect(row.spentLabel).toBe('$120 of $150');
  });

  it('the tick sits on the base pace target, on a bar scaled to the envelope', () => {
    // No rollover: envelope == budget, tick unchanged at elapsed.
    expect(budgetRowFor({ budget: 100, posted: 30, pending: 0 }).targetPct).toBe(50);
    // Rollover leftovers: $200 envelope, $50 pace → a quarter along the bar.
    const leftovers = budgetRowFor({ budget: 100, posted: 30, pending: 0, rollover: true, carryover: 100 });
    expect(leftovers.targetPct).toBe(25);
    // Past overspend: $70 envelope, $50 pace → right of halfway.
    expect(budgetRowFor({ budget: 100, posted: 10, pending: 0, rollover: true, carryover: -30 }).targetPct).toBe(71);
    // Past overspend bigger than the pace: $40 envelope, $50 pace → capped at the end of the bar.
    expect(budgetRowFor({ budget: 100, posted: 10, pending: 0, rollover: true, carryover: -60 }).targetPct).toBe(100);
    // Drained envelope: the bar falls back to the base budget, so the tick is at elapsed.
    expect(budgetRowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: -100 }).targetPct).toBe(50);
    // Spread cushion: $160 envelope, $50 pace.
    const cushion = budgetRowFor({ budget: 100, posted: 30, pending: 0, spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } });
    expect(cushion.targetPct).toBe(31);
  });

  // Across envelopes and clocks: "Over plan" on the detail is always in muted ink, and the row and
  // the detail put the tick in the same place.
  it('[A13] detail "Over plan" in muted colour, same tick on row and detail', () => {
    const envelopes: Partial<Budget>[] = [
      {},
      { rollover: true, carryover: 100 },
      { rollover: true, carryover: -30 },
      { spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } },
    ];
    const clocks = [{ cycleLen: 14, daysLeft: 13 }, { cycleLen: 14, daysLeft: 7 }, { cycleLen: 14, daysLeft: 1 }, { cycleLen: 30, daysLeft: 0 }];
    let warned = 0, quiet = 0;
    for (const extra of envelopes) for (const clock of clocks) for (let posted = 0; posted <= 200; posted += 10) {
      const b = budget({ id: 'coffee', budget: 100, posted, pending: 0, ...extra });
      const state = makeState({ budgets: [b], ...clock });
      const row = budgetViews(state).rows[0];
      const d = budgetDetail(state, 'coffee')!;
      if (d.statusLabel === 'Over plan — ease up') {
        expect(d.statusColor).toBe(C.textInfo);
        warned++;
      } else if (!row.over) quiet++;
      expect(d.targetPct).toBe(row.targetPct);
      const available = b.available;
      expect(row.targetPct).toBe(pacePct(paceTarget(b, clock), available > 0 ? available : 100));
    }
    expect(warned).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(0);
  });
});

// A rollover budget pulled down by a carried-over deficit, or a spread bill's payback, makes this
// cycle's budget negative: the row keeps the minus (real minus U+2212) and says why in its note.
describe('budget rows — negative budgets and their notes', () => {
  it('Utilities: $200 target, carryover −859 → "of −$659" + "Includes $859 past overspend"', () => {
    const row = budgetRowFor({ budget: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859 });
    expect(row.spentLabel).toBe(`$617.75 of ${MINUS}$659`);
    expect(row.note).toBe('Includes $859 past overspend');
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$1,276.75');
  });

  it('a payback cycle reads "$617.75 of −$659" and notes the spread', () => {
    // $41 target − $700 payback slice → this cycle's budget is −$659.
    const row = budgetRowFor({
      budget: 41, posted: 617.75, pending: 0, spreadAdjustment: -700,
      spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 },
    });
    expect(row.spentLabel).toBe(`$617.75 of ${MINUS}$659`);
    expect(row.note).toBe('Includes spread bills');
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$1,276.75');
  });
});

// WHIT-69: an Income-bucket category's budget is an earn-target (a floor). Over is
// GOOD, so the direction and colours invert — never the red "over budget" branch —
// and income rows are kept OUT of the spend hero totals.
const RED = C.bad;

describe('budgetViews — income earn-targets (over-is-good)', () => {
  // elapsed = 0.5, budget 5000 → linear target 2500.
  const incomeRow = (posted: number, pending = 0) => budgetRowFor({ budget: 5000, posted, pending }, SALARY);

  it('under target early in the cycle is never red and reads "to go"', () => {
    const row = incomeRow(1000);
    expect(row.over).toBe(false);
    expect(row.remainLabel).toBe('to go');
    expect(row.remainAmount).toBe('$4,000');       // 5000 - 1000 still to earn
    expect(row.remainColor).not.toBe(RED);
    expect(row.postedColor).toBe(C.accentSoft);     // bar uses the shared calm fill, not red
    expect(row.pendingTint).toBe(tint(C.accentSoft, 0.45));
    // WHIT-707: salary lands in one lump, so there's no today marker.
    expect(row.showTarget).toBe(false);
  });

  it('ahead of the linear pace is still not met', () => {
    const row = incomeRow(3000);   // 3000 > 2500 target, < 5000 goal
    expect(row.remainLabel).toBe('to go');
    expect(row.over).toBe(false);
  });

  it('meeting or exceeding the target is green and reads "above target"', () => {
    const row = incomeRow(6000);   // earned 6000 ≥ 5000 floor
    expect(row.remainLabel).toBe('above target');
    expect(row.remainAmount).toBe('$1,000');        // 6000 - 5000 over the floor
    expect(row.remainColor).toBe(C.good);
    expect(row.over).toBe(false);
  });

  it('earned EXACTLY at the floor → met, "above target", remain $0, green, not red', () => {
    const row = incomeRow(5000);
    expect(row.remainLabel).toBe('above target');
    expect(row.remainAmount).toBe('$0');           // actual - budget = 0
    expect(row.remainColor).toBe(C.good);
    expect(row.over).toBe(false);
    expect(row.postedColor).not.toBe(RED);
    expect(row.postedColor).toBe(C.accentSoft);
  });

  it('excludes income rows from the spend hero totals but still lists them', () => {
    const s = makeState({
      categories: [cat(), SALARY],
      budgets: [
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(rows).toHaveLength(2);                    // income row is still listed
    expect(totBudget).toBe(100);                     // only the spend budget counts
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
  });
});

describe('budgetDetail — income earn-targets', () => {
  const incomeDetail = (posted: number) => detail({ budget: 5000, posted }, undefined, SALARY);

  it('under target: calm "keep earning" status, never red, reframed daily label', () => {
    const d = incomeDetail(1000);
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).not.toBe(RED);
    expect(d.postedColor).toBe(C.accentSoft);
    expect(d.pendingTint).toBe(tint(C.accentSoft, 0.45));
    expect(d.dailyLabel).toContain('to target');   // "$X/day to target", not "Daily limit"
    expect(d.dailyLabel).not.toContain('Daily limit');
  });

  it('target reached: green status and no daily-to-go', () => {
    const d = incomeDetail(6000);
    expect(d.statusLabel).toBe('Target reached — nice');
    expect(d.statusColor).toBe(C.good);
    expect(d.dailyLabel).toBe('Target reached');
  });

  it('under target with pending → perDay-to-target uses the shortfall, pendingPct not capped', () => {
    const d = detail({ budget: 5000, posted: 1000, pending: 500 }, undefined, SALARY); // actual 1500, toGo 3500, 7 days left
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).toBe('#cfd2ff');
    expect(d.dailyLabel).toBe('$500/day to target'); // 3500 / max(1,7) = 500
    expect(d.postedPct).toBe(20);
    expect(d.pendingPct).toBe(10);                   // 500/5000, under the cap
  });

  it('[G8] income budget past pace stays "keep earning", never amber', () => {
    // actual 900 < target 1000 (not met) but way past linear pace (500). Income → calm.
    const d = detail({ budget: 1000, posted: 900 }, { cycleLen: 14, daysLeft: 7 }, cat({ bucket: 'Income', name: 'Salary' }));
    expect(d.statusLabel).toBe('On track — keep earning');
    expect(d.statusColor).toBe(C.textInfo);
    expect(d.statusColor).not.toBe(C.warn);
  });
});

// WHIT-201: a Savings-bucket budget has no meaningful rollup (savings is an account
// balance, not categorised spend), so budgetViews skips it entirely — row AND totals —
// and budgetDetail treats it as absent. New Savings budgets are blocked in the picker;
// this covers one set before that / via re-bucketing.
describe('budgetViews — Savings budgets are skipped (WHIT-201)', () => {
  it('omits a Savings budget row and excludes it from the hero totals, while other buckets still render', () => {
    const s = makeState({
      categories: [
        cat(),
        cat({ id: 'salary', name: 'Salary', bucket: 'Income' }),
        cat({ id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings' }),
      ],
      budgets: [
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
        budget({ id: 'nest_egg', budget: 2000, posted: 0, pending: 0 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(rows.map((r) => r.id)).toEqual(['coffee', 'salary']);  // no nest_egg row
    // Totals are the spend row only (income is excluded too, per WHIT-69); the $2000
    // Savings target must NOT leak into totBudget.
    expect(totBudget).toBe(100);
    expect(totSpent).toBe(50);
    expect(totRemain).toBe(50);
  });
});

describe('budgetDetail', () => {
  it('returns null when the category or budget is missing', () => {
    expect(budgetDetail(makeState(), 'nope')).toBeNull();
  });

  it('returns null for a Savings-bucket budget (WHIT-201)', () => {
    const s = makeState({
      categories: [cat({ id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings' })],
      budgets: [budget({ id: 'nest_egg', budget: 2000, posted: 0, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    expect(budgetDetail(s, 'nest_egg')).toBeNull();
  });

  it('shows the exact spent total (cents) so the hero matches the rows it sums — 73.50, not a rounded $74', () => {
    const input: BudgetDetailInput = {
      category: (id: string) => (id === 'coffee' ? cat() : undefined),
      // posted 62.50 + pending 11.00 = 73.50 spent of an $80 budget (the reported Cafes & Coffee case)
      budgets: [budget({ id: 'coffee', budget: 80, posted: 62.5, pending: 11 })],
      transactions: [txn({ transaction_id: 'x1', category: 'coffee' })],
      cycleLen: 14,
      daysLeft: 7,
    };
    const bd = budgetDetail(input, 'coffee');
    expect(bd!.spentBig).toBe('$73.50');   // fail-on-revert: fmt(73.5) would render '$74'
    expect(bd!.ofBudget).toBe('of $80');   // exact, and $80 has no cents (WHIT-741)
  });

  it('computes a daily limit from remaining / days left, and $0 when over', () => {
    const ok = budgetDetail(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 30, pending: 0 })], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(ok.dailyLabel).toBe('Daily limit: $10'); // (100-30)/7 = 10
    const over = budgetDetail(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 130, pending: 0 })], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(over.dailyLabel).toBe('Daily limit: $0');
    expect(over.statusLabel).toContain('Over budget');
  });

  it('exposes the server-provided related transactions and flags empty', () => {
    const withTx = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [txn({ transaction_id: 'x', category: 'coffee', date: '2026-05-01' })],
    }), 'coffee')!;
    expect(withTx.relEmpty).toBe(false);
    expect(withTx.relItems.map((t) => t.transaction_id)).toEqual(['x']);
    const noTx = budgetDetail(makeState({ categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(noTx.relEmpty).toBe(true);
  });

  // The cycle window + subtree filtering now lives on the server (/budgets/{id}/transactions),
  // so budgetDetail must show the list VERBATIM — not re-filter it. Re-adding the old
  // `t.category === b.id` filter would drop a sub-category row that the total (a subtree
  // rollup) DOES count, re-opening the reconciliation gap.
  // FAIL-ON-REVERT: a client-side `t.category === 'coffee'` filter drops 'sub'.
  it('passes the server list through unfiltered (keeps a sub-category row)', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 10,
      transactions: [
        txn({ transaction_id: 'parent', category: 'coffee', date: '2026-07-19' }),
        txn({ transaction_id: 'sub', category: 'coffee-beans', date: '2026-07-18' }),
      ],
    }), 'coffee')!;
    expect(bd.relItems.map((t) => t.transaction_id)).toEqual(['parent', 'sub']);
  });

  // WHIT-525: during the optimistic window, a just-excluded row lingers in the budget cache
  // (stamped budget_excluded:true). budgetDetail must filter it out so the budget-detail list
  // doesn't show it. FAIL-ON-REVERT: removing the contributesToBudget filter lets the excluded
  // row through → relItems includes it → the budget list shows a charge it shouldn't.
  it('filters out a budget_excluded row from relItems (WHIT-525)', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'kept', category: 'coffee' }),
        txn({ transaction_id: 'excluded', category: 'coffee', budget_excluded: true }),
      ],
    }), 'coffee')!;
    expect(bd.relItems.map((t) => t.transaction_id)).toEqual(['kept']);
    expect(bd.relEmpty).toBe(false);
  });

  it('relEmpty is true when all rows are budget_excluded (WHIT-525)', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'only', category: 'coffee', budget_excluded: true }),
      ],
    }), 'coffee')!;
    expect(bd.relItems).toEqual([]);
    expect(bd.relEmpty).toBe(true);
  });
});

// The detail status must be pace-aware, matching the list (budgetViews): spending past
// today's linear target with little room left per day is a muted caution (WHIT-732), not a
// green "keep it up". Pace rides the base
// per-cycle budget (b.budget * elapsed), so it stays consistent with the list on both screens.
describe('budgetDetail — spend pace status', () => {
  // FAIL-ON-REVERT: today's binary code reads 3667 <= 3667 as green "On target — keep it up".
  it('100% spent on day 1 reads muted "over plan", not green, with no single charge behind it', () => {
    const d = detail({ budget: 3667, posted: 3667 }, { cycleLen: 30, daysLeft: 29 });
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.statusColor).toBe(C.textInfo);
    expect(d.statusColor).not.toBe(C.good);
    expect(d.dailyLabel).toBe('Daily limit: $0'); // envelope gone → nothing left per day
  });

  it('over plan but still under budget → muted, and the daily limit is not zeroed', () => {
    // elapsed 2/14 ≈ 0.143, target ≈ 14.3; spent 60 is well past pace, still under 100;
    // $40 over 12 days ($3.33/day) is under half the daily plan ($3.57).
    const d = detail({ budget: 100, posted: 60 }, { cycleLen: 14, daysLeft: 12 });
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.statusColor).toBe(C.textInfo);
    expect(d.dailyLabel).toContain('Daily limit');
    expect(d.dailyLabel).not.toBe('Daily limit: $0');
  });

  it('on/under plan late in the cycle stays green even near 100% (no over-flagging)', () => {
    // elapsed 13/14 ≈ 0.929, target ≈ 92.9; spent 90 is under plan → legit late spend.
    const d = detail({ budget: 100, posted: 90 }, { cycleLen: 14, daysLeft: 1 });
    expect(d.statusLabel).toBe('On track for payday');
    expect(d.statusColor).toBe(C.good);
  });

  it('pending spend counts toward pace (low posted, high pending crosses the target)', () => {
    // elapsed 0.5, target 50; spent = posted 10 + pending 75 = 85 → $2.14/day left → over plan.
    const d = budgetDetail(makeState({
      categories: [cat()], budgets: [budget({ id: 'coffee', budget: 100, posted: 10, pending: 75 })],
      cycleLen: 14, daysLeft: 7,
    }), 'coffee')!;
    expect(d.statusLabel).toBe('Over plan — ease up');
    expect(d.statusColor).toBe(C.textInfo);
  });

  it('$0 spent is never flagged — green', () => {
    const d = detail({ budget: 100, posted: 0 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusLabel).toBe('On track for payday');
    expect(d.statusColor).toBe(C.good);
  });

  it('truly over budget still reads red — the middle state did not steal it', () => {
    const d = detail({ budget: 100, posted: 130 }, { cycleLen: 14, daysLeft: 7 });
    expect(d.statusLabel).toBe('Over budget — ease up');
    expect(d.statusColor).toBe(C.bad);
    expect(d.dailyLabel).toBe('Daily limit: $0');
  });

  // A rollover leftovers budget only warns on the envelope's daily room, not the base pace alone.
  it('[A9] $200 envelope: $150 spent is quiet, $180 spent warns', () => {
    expect(detail({ budget: 100, posted: 150, rollover: true, carryover: 100 }).statusLabel).toBe('On track for payday');
    expect(detail({ budget: 100, posted: 180, rollover: true, carryover: 100 }).statusLabel).toBe('Over plan — ease up');
  });
});

// WHIT-739: a bill paid in full in one go (nothing left, one counting charge) has nothing to slow
// down — no "over plan" on the detail.
describe('budgetDetail — paid in one go (WHIT-739)', () => {
  const MORTGAGE = cat({ id: 'mortgage', name: 'Mortgage', bucket: 'Living' });
  const charge = (amount: number) => txn({ transaction_id: `m${amount}`, category: 'mortgage', amount: -amount });
  const mortgageDetail = (b: Partial<Budget>, transactions: Transaction[]) => budgetDetail(
    makeState({
      categories: [MORTGAGE],
      budgets: [budget({ id: 'mortgage', budget: 3667, posted: 3667, pending: 0, ...b })],
      transactions, cycleLen: 30, daysLeft: 21,
    }),
    'mortgage',
  )!;

  it('one counting charge of the full amount → "On track for payday", green', () => {
    const d = mortgageDetail({}, [charge(3667)]);
    expect(d.statusLabel).toBe('On track for payday');
    expect(d.statusColor).toBe(C.good);
  });

  // [A4b] the server-computed available is the envelope.
  it('server available: one charge using it all → quiet; a dollar short of it → still muted', () => {
    expect(mortgageDetail({ posted: 3800, available: 3800 }, [charge(3800)]).statusLabel).toBe('On track for payday');
    expect(mortgageDetail({ posted: 3799, available: 3800 }, [charge(3799)]).statusLabel).toBe('Over plan — ease up');
  });
});

// WHIT-742: a rollover budget's detail page lists the cycles its carryover came from, newest
// first, plus one remainder line for anything older, so the lines add up to the carryover note.
describe('budgetDetail — carryover cycle lines (WHIT-742)', () => {
  const cycle = (start: string, end: string, leftover: number, extra: object = {}) => ({
    start, end, target: 200, spent: 200 - leftover, leftover, settling: false, ...extra,
  });

  it('Utilities: each past overspend cycle on its own line, settling ones marked', () => {
    const d = detail({
      budget: 200, posted: 100, rollover: true, carryover: -859, carryoverEarlier: 0,
      carryoverCycles: [
        cycle('2026-09-12', '2026-09-25', -519.6, { settling: true }),
        cycle('2026-08-29', '2026-09-11', -339.4),
      ],
    });
    expect(d.carryoverLine).toBe('Includes $859 past overspend');
    expect(d.carryoverCycleLines).toHaveLength(2);
    expect(d.carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep', amount: '−$520', settling: true },
      { label: '29 Aug – 11 Sep', amount: '−$339', settling: false },
    ]);
  });

  it('rebuilt cycles are flagged and the gap reads "Not matched to a cycle"', () => {
    const d = detail({
      budget: 200, posted: 50, rollover: true, carryover: -300, carryoverEarlier: -20,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', -280, { rebuilt: true })],
    });
    expect(d.carryoverCycleLines).toMatchObject([
      { label: '12 Sep – 25 Sep', amount: '−$280', rebuilt: true },
      { label: 'Not matched to a cycle', amount: '−$20' },
    ]);
  });

  it('no saved cycles yet: the whole carryover is one "Earlier cycles" line', () => {
    const d = detail({ budget: 200, posted: 50, rollover: true, carryover: -859, carryoverEarlier: -859, carryoverCycles: [] });
    expect(d.carryoverCycleLines).toMatchObject([
      { label: 'Earlier cycles', amount: '−$859' },
    ]);
  });

  it('a carryover that nets to under 50c shows neither the note nor any cycle lines', () => {
    const d = detail({
      budget: 200, posted: 0, rollover: true, carryover: 0.2, carryoverEarlier: 0.2,
      carryoverCycles: [cycle('2026-09-12', '2026-09-25', 100), cycle('2026-08-29', '2026-09-11', -100)],
    });
    expect(d.carryoverLine).toBe('');
    expect(d.carryoverCycleLines).toEqual([]);
  });

  // "Before" names the OLDEST listed cycle, even with a settling one in front; keys unique.
  it('the remainder line is dated from the oldest cycle and every line has its own key', () => {
    const d = detail({
      budget: 200, posted: 0, rollover: true, carryover: -100, carryoverEarlier: -60,
      carryoverCycles: [
        cycle('2026-09-26', '2026-10-09', 20, { settling: true }),
        cycle('2026-09-12', '2026-09-25', -40),
        cycle('2026-08-29', '2026-09-11', -20),
      ],
    });
    const lines = d.carryoverCycleLines;
    expect(lines.map((l) => l.label)).toEqual(['26 Sep – 9 Oct', '12 Sep – 25 Sep', '29 Aug – 11 Sep', 'Before 29 Aug']);
    expect(lines.map((l) => l.amount)).toEqual(['+$20', '−$40', '−$20', '−$60']);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });

  // A legacy budget with no cycle fields at all (old cached data) still shows its note.
  it('a rollover budget missing both new fields falls back to no cycles and no remainder', () => {
    const d = detail({ budget: 200, posted: 0, rollover: true, carryover: -859, carryoverCycles: undefined, carryoverEarlier: undefined });
    expect(d.carryoverLine).toBe('Includes $859 past overspend');
    expect(d.carryoverCycleLines).toEqual([]);
  });
});

describe('groupTransactionsByDate', () => {
  it('groups by date heading, preserving the input (newest-first) order', () => {
    const groups = groupTransactionsByDate([
      txn({ transaction_id: 'a', date: '2026-07-21' }),
      txn({ transaction_id: 'b', date: '2026-07-21' }),
      txn({ transaction_id: 'c', date: '2026-07-18' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.items.map((t) => t.transaction_id))).toEqual([['a', 'b'], ['c']]);
  });

  it('a future-dated charge gets a weekday label, not Today/Yesterday', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12, 0) });
    try {
      expect(groupTransactionsByDate([txn({ date: '2026-10-07' })])[0].label).toBe('Wed 7 Oct');
    } finally {
      jest.useRealTimers();
    }
  });

  // Melbourne's clocks went forward on Sun 4 Oct 2026 (a 23-hour day); the labels must not slip.
  it('labels Today / Yesterday / weekday across a daylight-saving change', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 5, 0, 30) });
    try {
      const groups = groupTransactionsByDate([
        txn({ transaction_id: 'a', date: '2026-10-05' }),
        txn({ transaction_id: 'b', date: '2026-10-04' }),
        txn({ transaction_id: 'c', date: '2026-10-03' }),
      ]);
      expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Sat 3 Oct']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('budgetViews sub-category tree + hero de-dup (WHIT-221)', () => {
  const car = () => cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null });
  const parking = () => cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' });

  it('de-dups the hero total: a parent and its budgeted sub count the parent ONCE', () => {
    // Car (parent) rolled-up spend £75 (server-folded Parking+Other); Parking budgeted £50/£30.
    // Fail-on-revert: dropping the `depth === 0` guard makes this read 105 / 250.
    const s = makeState({
      categories: [car(), parking()],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totBudget, totSpent, totRemain } = budgetViews(s);
    expect(totSpent).toBe(75);   // only Car — Parking is already inside Car's roll-up
    expect(totBudget).toBe(200); // only Car's cap
    expect(totRemain).toBe(125);
    // both rows present, ordered parent-then-child, with depth/parentId set
    expect(rows.map((r) => r.id)).toEqual(['car', 'parking']);
    expect(rows[0]).toMatchObject({ id: 'car', depth: 0, parentId: null });
    expect(rows[1]).toMatchObject({ id: 'parking', depth: 1, parentId: 'car' });
  });

  it('walks through an UN-budgeted middle node to find the budgeted ancestor', () => {
    // car budgeted, daily NOT budgeted, petrol budgeted under daily. petrol's nearest
    // budgeted ancestor is car → it nests under car at depth 1 and is skipped from the hero.
    const s = makeState({
      categories: [car(),
                   cat({ id: 'daily', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', bucket: 'Living', parent: 'daily' })],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'petrol', budget: 40, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent } = budgetViews(s);
    expect(totSpent).toBe(75); // petrol skipped (has a budgeted ancestor)
    expect(rows.map((r) => r.id)).toEqual(['car', 'petrol']);
    expect(rows[1]).toMatchObject({ id: 'petrol', depth: 1, parentId: 'car' });
  });

  it('counts a budgeted sub whose parent is NOT budgeted, at top level', () => {
    // car has no budget row (target 0 → absent from budgets[]); parking budgeted under it.
    const s = makeState({
      categories: [car(), parking()],
      budgets: [budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(totSpent).toBe(30);   // no budgeted ancestor → counts
    expect(totBudget).toBe(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'parking', depth: 0, parentId: null });
  });

  it('keeps Income parent/sub out of the spend hero but still nests them', () => {
    const s = makeState({
      categories: [cat({ id: 'income', bucket: 'Income', parent: null }),
                   cat({ id: 'salary', bucket: 'Income', parent: 'income' })],
      budgets: [budget({ id: 'income', budget: 6000, posted: 4000, pending: 0 }),
                budget({ id: 'salary', budget: 5000, posted: 4000, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(totSpent).toBe(0);    // income never enters the spend hero
    expect(totBudget).toBe(0);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['income', 0], ['salary', 1]]);
  });
});

// ===== WHIT-221 (folded from budgetTreeGaps.logic.test.ts) — budgetViews sub-category tree:
// ADVERSARIAL GAP tests the implementer's budget.logic.test.ts does NOT cover: multi-family
// independence, the exact child-before-parent ordering the two-pass exists to fix, depth-first
// emission with multiple children + a grandchild, a parent with all subs un-budgeted, and a Savings
// parent/sub pair (both skipped, no crash). No module-level const collisions; imports covered by the
// survivor.
describe('budgetViews sub-category tree — gaps (WHIT-221)', () => {
  // [A20] The exact bug the two-pass prevents: a budgeted sub sorts BEFORE its
  // budgeted parent in budgets[]. A single build-as-you-go pass would not yet know
  // the parent is budgeted when it hits the sub, count the sub at depth 0, and
  // double-count the family. Pass 1 (build budgetedRowIds up front) must prevent that.
  it('de-dups even when the sub sorts BEFORE its parent in budgets[]', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' })],
      // parking (the CHILD) listed first — the ordering that breaks a naive one-pass.
      budgets: [budget({ id: 'parking', budget: 50, posted: 30, pending: 0 }),
                budget({ id: 'car', budget: 200, posted: 75, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget, totRemain } = budgetViews(s);
    expect(totSpent).toBe(75);   // Car only; NOT 75 + 30 = 105
    expect(totBudget).toBe(200); // Car only; NOT 250
    expect(totRemain).toBe(125);
    // Emitted parent-first regardless of the incoming child-first order.
    expect(rows.map((r) => r.id)).toEqual(['car', 'parking']);
    expect(rows[0]).toMatchObject({ id: 'car', depth: 0, parentId: null });
    expect(rows[1]).toMatchObject({ id: 'parking', depth: 1, parentId: 'car' });
  });

  // [A22] Depth-first emission with two children AND a grandchild. Order must be
  // parent → child1 → grandchild(of child1) → child2, with depths 0,1,2,1.
  it('emits depth-first: parent, child1, grandchild, child2 (multi-child + grandchild)', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'daily', name: 'Daily', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'daily' }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' })],
      budgets: [budget({ id: 'car', budget: 300, posted: 100, pending: 0 }),
                budget({ id: 'daily', budget: 100, posted: 50, pending: 0 }),
                budget({ id: 'petrol', budget: 40, posted: 20, pending: 0 }),
                budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent } = budgetViews(s);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['car', 0], ['daily', 1], ['petrol', 2], ['parking', 1],
    ]);
    expect(totSpent).toBe(100); // only Car (top of the single family)
  });

  // [A25] A spend sub with a CROSS-BUCKET budgeted ancestor (a Living sub under a
  // budgeted Income parent — only reachable via legacy/corrupt data; the server's
  // same-bucket rule blocks it on write). The de-dup only skips a row that has a
  // SAME-BUCKET budgeted ancestor, so this spend sub is NOT dropped: it counts once
  // on its own (depth 0). Fail-on-revert: removing the same-bucket check in
  // walkBudgetedAncestors makes `odd` depth 1 and silently drops its £40 from the hero.
  it('counts a spend sub whose only budgeted ancestor is a different bucket (no silent drop)', () => {
    const s = makeState({
      categories: [cat({ id: 'income', name: 'Income', bucket: 'Income', parent: null }),
                   cat({ id: 'odd', name: 'Odd Spend', bucket: 'Living', parent: 'income' })],
      budgets: [budget({ id: 'income', budget: 5000, posted: 4000, pending: 0 }),
                budget({ id: 'odd', budget: 100, posted: 40, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    // The spend sub counts once (Income parent is excluded from the spend hero by bucket).
    expect(totSpent).toBe(40);
    expect(totBudget).toBe(100);
    // and it renders at the top level, not nested under the Income row.
    expect(rows.find((r) => r.id === 'odd')).toMatchObject({ depth: 0, parentId: null });
  });
});

// The spendable "available" is now computed server-side and read straight off the Budget
// (WHIT-549); the client never adds up target + cushion itself (WHIT-840). These pin: the server
// value is the envelope.
describe('budgetViews — server-computed available (WHIT-549)', () => {
  it('uses the server available when present, not the client parts-sum', () => {
    // budget 100 but the server sends available 500 (a big smoothing cushion). The row spends the
    // SERVER envelope: remain / "of" read 500, not the 100 the parts-sum fallback would give.
    const row = budgetViews(makeState({ categories: [cat()],
      budgets: [budget({ budget: 100, posted: 0, pending: 0, available: 500 })],
      cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.remainAmount).toBe('$500');
    expect(row.spentLabel).toBe('$0 of\u00a0$500');
  });
});

// WHIT-549 GAP — a NEGATIVE server available (a payback cycle or a rollover deficit drains the
// envelope below 0). The implementer pinned available 500 / 0 / undefined; these pin that a
// negative server value is read verbatim and drives over/den, not clamped or bypassed.
describe('budgetViews/budgetDetail — negative server available (WHIT-549 gap)', () => {
  it('[Gc1] a negative server available reads as over, with a finite bar % from the base-target den', () => {
    // The server sends available -50 (envelope borrowed past 0); the parts-sum fallback would be
    // +100 (calm, under). posted 20 is the discriminator: the `den = available>0 ? available : base`
    // guard makes postedPct = 20/100 = 20; if den wrongly used the -50 envelope, clamp() floors it
    // to 0. So this pins the fallback den guard, not merely non-NaN. over = 20 > -50 = true.
    const row = budgetViews(makeState({ categories: [cat()],
      budgets: [budget({ budget: 100, posted: 20, pending: 0, available: -50 })],
      cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.over).toBe(true);
    expect(row.remainLabel).toBe('over');
    expect(row.postedPct).toBeCloseTo(20, 5);   // finite AND correct: den fell back to the base target
    // "of" reflects the SERVER envelope, signed since WHIT-728 — proving it isn't the +100 the
    // fallback parts-sum would have produced.
    expect(row.spentLabel).toBe(`$20 of\u00a0${MINUS}$50`);
  });

  it('[Gc2] budgetDetail reads a negative server available as over budget', () => {
    const d = budgetDetail(makeState({ categories: [cat()],
      budgets: [budget({ id: 'coffee', budget: 100, posted: 0, pending: 0, available: -50 })],
      cycleLen: 14, daysLeft: 7 }), 'coffee')!;
    expect(d.ofBudget).toBe(`of\u00a0${MINUS}$50`);      // the server envelope, not the fallback +100
    expect(d.statusLabel).toBe('Over budget — ease up');
  });

  it('[Gc3] a negative available still feeds hero totals from available, not budget', () => {
    // Hero totBudget/totRemain sum `available`, not the base budget. A -50 envelope must contribute
    // -50 to totBudget, proving the totals read the server value too (fallback would add +100).
    const { totBudget, totRemain } = budgetViews(makeState({ categories: [cat()],
      budgets: [budget({ budget: 100, posted: 0, pending: 0, available: -50 })],
      cycleLen: 14, daysLeft: 7 }));
    expect(totBudget).toBe(-50);
    expect(totRemain).toBe(-50);
  });
});
