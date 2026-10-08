import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { C, MINUS, tint, fmtSignedExact } from '../theme';
import { formatWeekdayShort } from '../dateutil';
import { makeState, cat, budget, txn } from './factory';
import { budgetRowFor, rowText, budgetDetailFor, budgetRowsFor, rowIds } from './support/budgetsTab';
import { SALARY, COFFEE, DINING, GROCERIES, LATTE } from './support/categories';
import { urgentFirst } from '../budgetOrder';
import { buildBudgetRows } from '../cycleExport';
import { availableToSpend, paceWarning, pacePct, paceTarget } from '../budgetMath';
import { toBudget } from '../model';
import type { Budget } from '../model';
import type { Transaction } from '../types';

describe('WHIT-707 budget row text', () => {
  // WHIT-707 QA — adversarial edges on the Budgets tab row text (budgetViews): the payday label's
  // weekday/date boundary, the quiet over-budget row, pending in the spent amount,
  // Spending-before-Earning ordering with nested income, and the date helpers.
  // Runs under TZ=Australia/Melbourne (npm test), so the daylight-saving cases are real.
  const salary = cat({ id: 'salary', name: 'Salary', color: '#35d9a0', bucket: 'Income' });
  const bonus = cat({ id: 'bonus', name: 'Bonus', color: '#35d9a0', bucket: 'Income', parent: 'salary' });
  const coffee = cat();
  const latte = cat({ id: 'latte', name: 'Lattes', bucket: 'Lifestyle', parent: 'coffee' });
  const rent = cat({ id: 'rent', name: 'Rent', bucket: 'Living' });

  const incomeRow = (daysLeft: number, nextPayday: string) => budgetViews({
    ...makeState({ categories: [salary], budgets: [budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 })], cycleLen: 14, daysLeft }),
    nextPayday,
  }).rows[0];

  describe('income "next pay" label boundaries (decision 3)', () => {
    // [A1] (P0) 1 day out → weekday.
    it('[A1] daysLeft 1 → "~Sun" (weekday)', () => {
      expect(incomeRow(1, '2026-10-04').spentLabel).toBe('$1,000 earned · next pay ~Sun');
    });

    // [A2] (P0) exactly 6 days → still a weekday (the "within 6 days" limit is inclusive).
    it('[A2] daysLeft 6 → weekday, not a date', () => {
      expect(incomeRow(6, '2026-10-09').spentLabel).toBe('$1,000 earned · next pay ~Fri');
    });

    // [A3] (P0) exactly 7 days → the date (a weekday a week out is ambiguous).
    it('[A3] daysLeft 7 → "~10 Oct" (date, not weekday)', () => {
      expect(incomeRow(7, '2026-10-10').spentLabel).toBe('$1,000 earned · next pay ~10 Oct');
    });

    // [A4] (P2) daysLeft 0 (only via clamping) → "today".
    it('[A4] daysLeft 0 → "today"', () => {
      expect(incomeRow(0, '2026-10-03').spentLabel).toBe('$1,000 earned · next pay today');
    });

    // [A5] (P1) empty nextPayday string → no dangling " · next pay".
    it('[A5] an empty nextPayday adds nothing', () => {
      expect(incomeRow(6, '').spentLabel).toBe('$1,000 earned');
    });
  });

  describe('over budget: quiet row', () => {
    // [A6] (P0) over with an active spread → the red amount says it once.
    it('[A6] over with an active spread → the red amount says it once', () => {
      const row = budgetRowFor({
        budget: 100, posted: 130, pending: 0, spreadAdjustment: -10,
        spread: { amount: 60, cycles: 3, index: 2, adjustment: -10 },
      });
      expect(row.over).toBe(true);
      expect(row.remainAmount).toBe('$40');
      expect(row.remainColor).toBe(C.bad); // rose stays on the amount
    });

    // [A7] (P1) a sub-cent overshoot still counts as over.
    it('[A7] sub-cent overshoot → over', () => {
      expect(budgetRowFor({ budget: 100, posted: 100.004, pending: 0 }).over).toBe(true);
    });

    // [A8] (P0) pending pushes a row over budget.
    it('[A8] over with pending → pending counted in spent, over', () => {
      const row = budgetRowFor({ budget: 100, posted: 90, pending: 25 });
      expect(row.spentLabel).toBe('$115 of\u00a0$100');
      expect(row.over).toBe(true);
    });

    // [A9] (P0) over plan but under budget → not over.
    it('[A9] over plan but under budget → not over', () => {
      const row = budgetRowFor({ budget: 100, posted: 90, pending: 0 }); // target 50
      expect(row.over).toBe(false);
    });

    // [A11] (P1) rollover drained into a deficit, over → the exact overspend on the amount, no pace warning.
    it('[A11] rollover with a borrowed buffer, over → the exact overspend on the amount', () => {
      const row = budgetRowFor({ budget: 100, posted: 95, pending: 0, rollover: true, carryover: -20 });
      expect(row.over).toBe(true);
      expect(row.remainAmount).toBe('$15');
    });
  });

  describe('pending in the spent amount', () => {
    // [A12] (P1) a sub-cent pending float adds no "pending" words.
    it('[A12] pending 0.004 → no pending words', () => {
      const row = budgetRowFor({ budget: 100, posted: 40, pending: 0.004 });
      expect(row.spentLabel).not.toContain('pending');
    });

    // [A13] (P1) one cent pending is real → counted with cents.
    it('[A13] pending 0.01 → counted in spent', () => {
      const row = budgetRowFor({ budget: 100, posted: 40, pending: 0.01 });
      expect(row.spentLabel).toBe('$40.01 of\u00a0$100');
    });

    // [A14] (P1) rollover envelope: "of" shows the available envelope, pending counted in spent.
    it('[A14] rollover with carryover → "of" the envelope, pending in spent', () => {
      const row = budgetRowFor({ budget: 100, posted: 30, pending: 20, rollover: true, carryover: 50 });
      expect(row.spentLabel).toBe('$50 of\u00a0$150');
    });
  });

  describe('Spending before Earning ordering', () => {
    // [A15] (P0) nested income (parent + sub) listed first, interleaved with a spend family →
    // spend family first (sub after parent), then income family (sub after parent, depth kept).
    it('[A15] income family moves after all spend rows with nesting intact', () => {
      const { rows, totBudget, totSpent } = budgetViews(makeState({
        categories: [salary, bonus, coffee, latte, rent],
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

    // [A16] (P1) income only → every row is earning, none hidden.
    it('[A16] only income budgets → all rows earning', () => {
      const { rows } = budgetViews(makeState({
        categories: [salary], budgets: [budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 })], cycleLen: 14, daysLeft: 7,
      }));
      expect(rows.map((r) => [r.id, r.section, r.showTarget])).toEqual([['salary', 'earning', false]]);
    });
  });

  describe('date helpers around Melbourne daylight saving', () => {
    // [A17] and [A18] (late evening around the DST changes) now run through nextPayday in
    // whit710PayCycleCleanup.logic.test.ts.

    // [A19] (P2) weekday on the DST-change days, and garbage input → ''.
    it('[A19] formatWeekdayShort on DST days and garbage', () => {
      expect(formatWeekdayShort('2026-04-05')).toBe('Sun');
      expect(formatWeekdayShort('2026-10-05')).toBe('Mon');
      expect(formatWeekdayShort('not-a-date')).toBe('');
    });
  });
});

describe('WHIT-712 quiet budget rows', () => {
  // WHIT-712 — budget rows stay quiet by default: one money line ("$X of $Y"), no
  // "on pace" line, the overspend said once, and carried-over / borrowed only on the detail screen.
  describe('budget rows stay quiet (WHIT-712)', () => {
    it('an on-pace row shows what is left', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0 });
      expect(row.remainAmount).toBe('$50');
      expect(row.remainLabel).toBe('left');
    });

    it('over budget says the overspend once, in the red amount', () => {
      const row = budgetRowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
      expect(row.remainAmount).toBe('$20');
      expect(row.remainLabel).toBe('over');
      expect(row.remainColor).toBe(C.bad);
      expect(rowText(row).match(/\$20(?![\d.,])/g)).toHaveLength(1);
    });

    it('the money line reads "$X of $Y", pending included, no pending line (WHIT-744)', () => {
      const row = budgetRowFor({ budget: 600, posted: 374, pending: 38 });
      expect(row.spentLabel).toBe('$412 of\u00a0$600');
      expect(budgetRowFor({ budget: 100, posted: 40, pending: 0 }).spentLabel).toBe('$40 of\u00a0$100');
    });

    it('no row field mentions the carry-over', () => {
      for (const carryover of [200, -40]) {
        const row = budgetRowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover });
        expect(rowText(row)).not.toMatch(/carried over|borrowed|short from|left over from/);
        expect(row).not.toHaveProperty('carryoverLabel');
      }
    });
  });

  // WHIT-712 QA — the pace deadband edges now that "on pace" is silent: exactly ±$0.50 off pace
  // stays calm on the detail screen; and an overspend in cents is said once, exactly, on the row.
  describe('pace deadband edges (WHIT-712)', () => {
    // [A1] (P0) exactly $0.50 either side of pace is still "on pace" → no warning.
    it('[A1] exactly ±$0.50 off pace → on track', () => {
      expect(budgetDetailFor({ budget: 100, posted: 50.5 }).statusLabel).toBe('On track for payday');
      expect(budgetDetailFor({ budget: 100, posted: 49.5 }).statusLabel).toBe('On track for payday');
    });

    // [A3] (P1) spent exactly the budget is NOT over: amount "left", and over plan in detail.
    it('[A3] spent exactly the budget → not over, $0 left, over plan', () => {
      const row = budgetRowFor({ budget: 100, posted: 100, pending: 0 });
      expect(row.over).toBe(false);
      expect(row.remainAmount).toBe('$0');
      expect(row.remainLabel).toBe('left');
      expect(budgetDetailFor({ budget: 100, posted: 100 }).statusLabel).toBe('Over plan — ease up');
    });

    // [A4] (P1) a cents overspend with no spread: the exact amount once, on the red amount only.
    it('[A4] over by $20.40 (rollover, no spread) → "$20.40" once', () => {
      const row = budgetRowFor({ budget: 100, posted: 120.4, pending: 0, rollover: true, carryover: 0 });
      expect(row.remainAmount).toBe('$20.40');
      expect(row.remainColor).toBe(C.bad);
      expect(row.spentLabel).toBe('$120.40 of\u00a0$100');
    });
  });
});

describe('WHIT-715 budget status words', () => {
  // WHIT-715 — budget status words say clearly whether it's good or bad: a budget too far
  // ahead of pace reads "over plan" in detail, income is "above target" ("over" is spending-only),
  // and the detail carry-over line says "Includes $X past leftovers" / "past overspend" (WHIT-733).
  const incomeRow = (b: object) => budgetRowFor({ pending: 0, ...b }, SALARY);

  describe('budget status words say good or bad plainly (WHIT-715)', () => {
    it('a met income target reads "above target", and no income row field says "over"', () => {
      const met = incomeRow({ budget: 100, posted: 120 });
      expect(met.remainLabel).toBe('above target');
      expect(rowText(met)).not.toMatch(/\bover\b/i);
      expect(incomeRow({ budget: 100, posted: 40 }).remainLabel).toBe('to go');
    });

    it('the detail carry-over line says past leftovers / past overspend', () => {
      expect(budgetDetailFor({ budget: 100, posted: 10, rollover: true, carryover: 40 }).carryoverLine)
        .toBe('Includes $40 past leftovers');
      expect(budgetDetailFor({ budget: 100, posted: 10, rollover: true, carryover: -20 }).carryoverLine)
        .toBe('Includes $20 past overspend');
    });
  });

  // WHIT-715 QA — the detail screen's pace words across budgets with pending, rollover buffers either
  // side of zero, and every point in the cycle: never "over plan" when over budget, always in muted ink.
  describe('detail pace words across the grid (WHIT-715 QA)', () => {
    // [A1] (P0) "Over plan — ease up" only when under budget, and always in C.textInfo.
    it('[A1] the detail pace words hold for every case in the grid', () => {
      let behindSeen = 0;
      for (const daysLeft of [1, 7, 13])
        for (const posted of [0, 20, 47, 49.6, 50.4, 52, 70, 99, 130])
          for (const pending of [0, 15])
            for (const carryover of [0, 40, -30]) {
              const detail = budgetDetailFor(
                { budget: 100, posted, pending, rollover: carryover !== 0, carryover },
                { cycleLen: 14, daysLeft },
              );
              const where = JSON.stringify({ daysLeft, posted, pending, carryover, detail: detail.statusLabel });
              const over = posted + pending > 100 + carryover;
              const behind = detail.statusLabel === 'Over plan — ease up';
              if (over) expect([where, behind]).toEqual([where, false]);
              if (!behind) continue;
              expect([where, detail.statusColor]).toEqual([where, C.textInfo]);
              behindSeen++;
            }
      expect(behindSeen).toBeGreaterThan(0);
    });
  });
});

describe('WHIT-727 urgent rows first', () => {
  // WHIT-727 QA — urgentFirst edges the acceptance tests don't reach: a three-level family lifted
  // by its grandchild, a corrupt parent loop (no row dropped or doubled), and the CSV export
  // keeping category order (sign-off Q2). Expected orders are written by hand.
  const oat = cat({ id: 'oat', name: 'Oat lattes', parent: 'latte' });

  describe('urgentFirst — edges', () => {
    // [A1] (P0) an over grandchild lifts its whole three-level family above the rest (a behind-pace
    // row isn't lifted, WHIT-745), and all three rows stay together with their depths.
    it('lifts a three-level family by its over grandchild, keeping it in one block', () => {
      const rows = budgetRowsFor([GROCERIES, DINING, COFFEE, LATTE, oat], [
        budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
        budget({ id: 'dining', budget: 100, posted: 85, pending: 0 }),
        budget({ id: 'coffee', budget: 300, posted: 100, pending: 0 }),
        budget({ id: 'latte', budget: 100, posted: 50, pending: 0 }),
        budget({ id: 'oat', budget: 20, posted: 30, pending: 0 }),
      ]);
      const ordered = urgentFirst(rows);
      expect(rowIds(ordered)).toEqual(['coffee', 'latte', 'oat', 'groceries', 'dining']);
      expect(ordered.map((r) => r.depth)).toEqual([0, 1, 2, 0, 0]);
    });

    // [A2] (P1) a corrupt parent loop (each names the other): every row is still listed exactly
    // once, the loop doesn't join the unrelated family before it, and an over loop row moves up.
    it('keeps a corrupt parent loop whole and separate from the family before it', () => {
      const loopA = cat({ id: 'loop_a', name: 'Loop A', parent: 'loop_b' });
      const loopB = cat({ id: 'loop_b', name: 'Loop B', parent: 'loop_a' });
      const rows = budgetRowsFor([GROCERIES, DINING, loopA, loopB], [
        budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
        budget({ id: 'dining', budget: 100, posted: 85, pending: 0 }),
        budget({ id: 'loop_a', budget: 100, posted: 150, pending: 0 }),
        budget({ id: 'loop_b', budget: 100, posted: 10, pending: 0 }),
      ]);
      const ordered = urgentFirst(rows);
      expect(ordered).toHaveLength(rows.length);
      expect(new Set(rowIds(ordered))).toEqual(new Set(rowIds(rows)));
      expect(rowIds(ordered).slice(0, 2)).toEqual(['loop_a', 'loop_b']);
      expect(rowIds(ordered).slice(2)).toEqual(['groceries', 'dining']);
    });
  });

  // [A3] (P1) sign-off Q2: the export keeps category order even when a later budget is over.
  it('the budgets export keeps category order with an over-budget budget listed second', () => {
    const category = (id: string) => [COFFEE, DINING].find((c) => c.id === id);
    const rows = buildBudgetRows([
      budget({ id: 'coffee', budget: 100, posted: 10, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
    ], category, false);
    expect(rows.slice(1).map((row) => row[1])).toEqual(['Cafes & Coffee', 'Dining']);
  });
});

describe('WHIT-728 rollover and spread rows', () => {
  // WHIT-728 follow-up — a rollover budget pulled down by a carried-over deficit reads
  // "$617.75 of −$659" and must say why with a muted "Includes $859 past overspend" (a positive
  // carryover → "Includes $40 past leftovers"). Maths, totals and the "over" label unchanged.
  const noteOf = (row: object) => (row as { note?: string }).note;

  describe('rollover budget rows explain their carryover (WHIT-728)', () => {
    it('Utilities: $200 target, carryover −859 → "of −$659" + "Includes $859 past overspend"', () => {
      const row = budgetRowFor({ budget: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859 });
      expect(row.spentLabel).toBe(`$617.75 of\u00a0${MINUS}$659`);
      expect(noteOf(row)).toBe('Includes $859 past overspend');
      expect(row.remainLabel).toBe('over');
      expect(row.remainAmount).toBe('$1,276.75');
    });

    it('a positive carryover → "Includes $40 past leftovers", label unchanged', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: true, carryover: 40 });
      expect(row.spentLabel).toBe('$50 of\u00a0$140');
      expect(noteOf(row)).toBe('Includes $40 past leftovers');
    });

    it.each([0.3, -0.3])('a tiny carryover (%p) → no note', (carryover) => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: true, carryover });
      expect(noteOf(row)).toBe('');
    });

    it('rollover off with a stale carryover → no note', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: false, carryover: -500 });
      expect(noteOf(row)).toBe('');
    });
  });

  // WHIT-728 follow-up QA — an Income row never carries a rollover note, even with rollover and a carryover.
  describe('rollover row note edges (WHIT-728)', () => {
    // [A2] an Income row with rollover and a deficit carryover stays note-free
    it('an Income rollover row shows no note', () => {
      const row = budgetRowFor(
        { budget: 100, posted: 50, pending: 0, rollover: true, carryover: -300 },
        cat({ bucket: 'Income' }),
      );
      expect(row.section).toBe('earning');
      expect(row.note).toBe('');
    });
  });

  // WHIT-728 — a spread bill's payback can make this cycle's budget negative. The row and the
  // detail screen must keep the minus ("of −$659", real minus U+2212), and the row notes the
  // spread with a muted "Includes spread bills". Maths, totals and the "over" label unchanged.
  const plan = (over = {}) => ({ amount: 2100, cycles: 3, index: 1, adjustment: -700, ...over });
  // $41 target − $700 payback slice → this cycle's budget is −$659.
  const payback = { budget: 41, posted: 617.75, pending: 0, spreadAdjustment: -700, spread: plan() };

  describe('budget rows keep the minus on a negative budget (WHIT-728)', () => {
    it('a payback cycle reads "$617.75 of −$659" and notes the spread', () => {
      const row = budgetRowFor(payback);
      expect(row.spentLabel).toBe(`$617.75 of\u00a0${MINUS}$659`);
      expect(row.note).toBe('Includes spread bills');
      expect(row.remainLabel).toBe('over');
      expect(row.remainAmount).toBe('$1,276.75');
    });

    it('a cushion (positive adjustment) has no minus but still notes the spread', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, spreadAdjustment: 200, spread: plan({ index: 0, adjustment: 200 }) });
      expect(row.spentLabel).not.toContain(MINUS);
      expect(row.spentLabel).toBe('$50 of\u00a0$300');
      expect(row.note).toBe('Includes spread bills');
    });

    it('no spread → no note, label unchanged', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0 });
      expect(row.note).toBe('');
      expect(row.spentLabel).toBe('$50 of\u00a0$100');
    });

    it('spread set but adjustment 0 → no note', () => {
      const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, spreadAdjustment: 0, spread: plan({ adjustment: 0 }) });
      expect(row.note).toBe('');
    });

    it('an Income row has an empty note', () => {
      const salary = cat({ id: 'salary', name: 'Salary', bucket: 'Income' });
      const row = budgetRowsFor([salary], [budget({ id: 'salary', budget: 5000, posted: 2500, pending: 0 })])[0];
      expect(row.note).toBe('');
    });

    it('the detail screen reads "of −$659"', () => {
      expect(budgetDetailFor(payback).ofBudget).toBe(`of\u00a0${MINUS}$659`);
    });
  });

  // WHIT-728 QA — the signed "of" survives pending spend, and a tiny negative budget never
  // reads "of −$0".
  describe('signed "of" edges (WHIT-728)', () => {
    // [A3] payback cycle with pending → "of −$659" (pending counted in spent).
    it('keeps the minus when some spend is pending', () => {
      const row = budgetRowFor({ budget: 41, posted: 600, pending: 17.75, spreadAdjustment: -700, spread: plan() });
      expect(row.spentLabel).toBe(`$617.75 of\u00a0${MINUS}$659`);
    });

    // [A4] a budget under a cent below zero rounds to $0 — never "−$0", on the row or the detail.
    it('a budget of −$0.003 reads "of $0", not "of −$0"', () => {
      const b = { budget: 0.997, posted: 5, pending: 0, spreadAdjustment: -1, spread: plan() };
      expect(budgetRowFor(b).spentLabel).toBe('$5 of\u00a0$0');
      expect(budgetDetailFor(b).ofBudget).toBe('of\u00a0$0');
    });
  });
});

describe('WHIT-729 under-budget bar fill', () => {
  // WHIT-729 — under-budget (and income) bars use one calm shared fill (soft Tokyo blue,
  // C.accentSoft), never the category colour: a red/pink category bar read as "over". Over stays
  // rose (C.bad). The category colour stays on the icon chip.
  const PINK = '#f7768e';
  const pinkSpend = cat({ color: PINK });
  const pinkIncome = { ...SALARY, color: PINK };

  describe('budgetViews rows', () => {
    it('under-budget spend bar uses the shared fill, not the category colour', () => {
      const row = budgetRowFor({ budget: 100, posted: 20, pending: 10 }, pinkSpend);
      expect(row.over).toBe(false);
      expect(row.postedColor).toBe(C.accentSoft);
      expect(row.pendingTint).toBe(tint(C.accentSoft, 0.45));
      expect(row.color).toBe(PINK);
      expect(row.chipBg).toBe(tint(PINK, 0.15));
    });

    it('over-budget spend bar stays rose', () => {
      const row = budgetRowFor({ budget: 100, posted: 120, pending: 0 }, pinkSpend);
      expect(row.over).toBe(true);
      expect(row.postedColor).toBe(C.bad);
      expect(row.pendingTint).toBe(tint(C.bad, 0.45));
    });

    it('income bar uses the shared fill, not the category colour', () => {
      const row = budgetRowFor({ budget: 5000, posted: 1000, pending: 200 }, pinkIncome);
      expect(row.postedColor).toBe(C.accentSoft);
      expect(row.pendingTint).toBe(tint(C.accentSoft, 0.45));
      expect(row.color).toBe(PINK);
    });
  });

  describe('budgetDetail', () => {
    it('under-budget spend detail bar uses the shared fill', () => {
      const d = budgetDetailFor({ budget: 100, posted: 20 }, undefined, pinkSpend);
      expect(d.postedColor).toBe(C.accentSoft);
      expect(d.pendingTint).toBe(tint(C.accentSoft, 0.45));
    });

    it('over-budget spend detail bar stays rose', () => {
      const d = budgetDetailFor({ budget: 100, posted: 150 }, undefined, pinkSpend);
      expect(d.postedColor).toBe(C.bad);
    });

    it('income detail bar uses the shared fill', () => {
      const d = budgetDetailFor({ budget: 5000, posted: 1000 }, undefined, pinkIncome);
      expect(d.postedColor).toBe(C.accentSoft);
      expect(d.pendingTint).toBe(tint(C.accentSoft, 0.45));
    });
  });
});

describe('WHIT-730 Budgets polish', () => {
  // WHIT-730 — Budgets polish. Over rows drop the "today" tick, a budget with nothing spent yet is
  // flagged `unspent` (drawn as a slim row), and the detail screen says "over plan" with the same tick rule.
  // Halfway through a 14-day cycle, so a $100 budget's pace target is $50.
  type Row = ReturnType<typeof budgetRowFor> & { unspent?: boolean };
  type Detail = ReturnType<typeof budgetDetailFor> & { showTarget?: boolean };

  describe('Budgets rows (WHIT-730)', () => {
    it('under-budget rows keep the tick, over rows hide it, and $0 rows are unspent', () => {
      const overPlan = budgetRowFor({ budget: 100, posted: 85, pending: 0 }) as Row;
      expect(overPlan.showTarget).toBe(true);
      expect(overPlan.unspent).toBe(false);

      const underPlan = budgetRowFor({ budget: 100, posted: 20, pending: 0 }) as Row;
      expect(underPlan.showTarget).toBe(true);

      const overBudget = budgetRowFor({ budget: 100, posted: 130, pending: 0 }) as Row;
      expect(overBudget.showTarget).toBe(false);
      expect(overBudget.unspent).toBe(false);

      expect((budgetRowFor({ budget: 100, posted: 0, pending: 0 }) as Row).unspent).toBe(true);
      expect((budgetRowFor({ budget: 100, posted: 0.01, pending: 0 }) as Row).unspent).toBe(false);
      // $41 target − $700 spread payback → a −$659 budget: $0 spent is still over, so not slim.
      const payback = budgetRowFor({
        budget: 41, posted: 0, pending: 0, spreadAdjustment: -700,
        spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 },
      }) as Row;
      expect(payback.unspent).toBe(false);

      const income = budgetRowsFor([SALARY], [budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 })])[0] as Row;
      expect(income.unspent).toBe(false);
    });

    it('the budget detail screen says "Over plan — ease up" and hides the tick when over', () => {
      const overPlan = budgetDetailFor({ budget: 100, posted: 85 }) as Detail;
      expect(overPlan.statusLabel).toBe('Over plan — ease up');
      expect(overPlan.showTarget).toBe(true);

      const overBudget = budgetDetailFor({ budget: 100, posted: 130 }) as Detail;
      expect(overBudget.statusLabel).toBe('Over budget — ease up');
      expect(overBudget.showTarget).toBe(false);
    });
  });

  // WHIT-730 QA — edges of the Budgets polish rules: the over-plan boundaries on the detail screen,
  // the "today" tick at exactly-on-budget, the `unspent` (slim row) rule for pending-only, a $0
  // budget and a nested row.
  // Halfway through a 14-day cycle, so a $100 budget's pace target is $50.
  describe('over plan (WHIT-730)', () => {
    it('[A2] within 50c of the plan is on track; pending counts toward being over plan', () => {
      expect(budgetDetailFor({ budget: 100, posted: 50.4 }).statusLabel).toBe('On track for payday');
      expect(budgetDetailFor({ budget: 100, posted: 49.6 }).statusLabel).toBe('On track for payday');
      expect(budgetDetailFor({ budget: 100, posted: 40, pending: 45 }).statusLabel).toBe('Over plan — ease up');
    });
  });

  describe('today tick (WHIT-730)', () => {
    it('[A4] spending exactly the whole budget is not over, but nothing is left so the tick hides (WHIT-741)', () => {
      const atLimit = budgetRowFor({ budget: 100, posted: 100, pending: 0 });
      expect(atLimit.over).toBe(false);
      expect(atLimit.showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 100, posted: 100 }).showTarget).toBe(false);
    });

    it('[A5] one cent over hides the tick on both the row and the detail screen', () => {
      expect(budgetRowFor({ budget: 100, posted: 100.01, pending: 0 }).showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 100, posted: 100.01 }).showTarget).toBe(false);
    });

    it('[A6] going over through pending alone hides the tick too', () => {
      expect(budgetRowFor({ budget: 100, posted: 60, pending: 50 }).showTarget).toBe(false);
    });

    it('[A7] an income budget keeps no tick on its row and keeps the tick on its detail screen', () => {
      const salary = budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 });
      expect(budgetRowsFor([SALARY], [salary])[0].showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 5000, posted: 1000 }, undefined, SALARY).showTarget).toBe(true);
    });
  });

  describe('unspent / slim rows (WHIT-730)', () => {
    it('[A8] a pending-only charge counts as spent, so the row stays full', () => {
      expect(budgetRowFor({ budget: 100, posted: 0, pending: 5 }).unspent).toBe(false);
    });

    it('[A9] a $0 row is unspent and still carries its amount left for the slim layout', () => {
      const zero = budgetRowFor({ budget: 100, posted: 0, pending: 0 });
      expect(zero.unspent).toBe(true);
      expect(zero.over).toBe(false);
      expect(zero.remainLabel).toBe('left');
      expect(zero.remainAmount).toBe('$100');
    });

    it('[A10] a $0 budget with nothing spent is unspent, not over', () => {
      const empty = budgetRowFor({ budget: 0, posted: 0, pending: 0 });
      expect(empty.over).toBe(false);
      expect(empty.unspent).toBe(true);
    });

    it('[A11] a nested $0 sub-budget is unspent while its spending parent is not', () => {
      const parent = cat({ id: 'food', name: 'Food', parent: null });
      const child = cat({ id: 'latte', name: 'Lattes', parent: 'food' });
      const rows = budgetRowsFor([parent, child], [
        budget({ id: 'food', budget: 200, posted: 30, pending: 0 }),
        budget({ id: 'latte', budget: 50, posted: 0, pending: 0 }),
      ]);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId.food.unspent).toBe(false);
      expect(byId.latte.unspent).toBe(true);
      expect(byId.latte.depth).toBe(1);
    });

    it('[A12] a $0 rollover row with past leftovers keeps its note for the slim layout', () => {
      const row = budgetRowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: 40 });
      expect(row.unspent).toBe(true);
      expect(row.note).toBe('Includes $40 past leftovers');
    });
  });
});

describe('WHIT-732 calm pace', () => {
  // WHIT-732 — calmer pace warning: a budget reads "over plan" only when the user really needs
  // to slow down (ahead of pace AND the daily room left is under half the daily plan), in muted
  // ink, never amber. The today tick sits on the base pace target the words use, even when the bar
  // is scaled to a rollover/spread envelope. Halfway through a 14-day cycle: $100 budget → $50 pace.
  describe('budget rows: a tick that matches the pace words (WHIT-732)', () => {
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

    it('the list order does not lift a row that is only slightly ahead', () => {
      const rows = budgetRowsFor([COFFEE, GROCERIES], [
        budget({ id: 'coffee', budget: 100, posted: 30, pending: 0 }),
        budget({ id: 'groceries', budget: 100, posted: 70, pending: 0 }),
      ]);
      expect(rowIds(urgentFirst(rows))).toEqual(['coffee', 'groceries']);
    });
  });

  describe('budget detail: calm pace warning (WHIT-732)', () => {
    it('slightly ahead with plenty left is not "Over plan"', () => {
      // $70 of $100 at halfway: $20 ahead, but $30 over 7 days ($4.29/day) is above half the daily plan ($3.57).
      expect(budgetDetailFor({ budget: 100, posted: 70 }).statusLabel).not.toBe('Over plan — ease up');
    });

    it('clearly needing to slow down reads "Over plan — ease up" in muted ink', () => {
      // $85 of $100 at halfway: $15 over 7 days ($2.14/day) is under half the daily plan ($3.57).
      const d = budgetDetailFor({ budget: 100, posted: 85 });
      expect(d.statusLabel).toBe('Over plan — ease up');
      expect(d.statusColor).toBe(C.textInfo);
    });

    it('the detail tick matches the row tick on a rollover envelope', () => {
      expect(budgetDetailFor({ budget: 100, posted: 30, rollover: true, carryover: 100 }).targetPct).toBe(25);
      expect(budgetDetailFor({ budget: 100, posted: 30 }).targetPct).toBe(50);
    });
  });

  // WHIT-732 QA — edges of the calmer "over plan" rule and the base-pace tick: the exact
  // half-daily-plan boundary, end of cycle, pending, over rows, income rows, and the row and the
  // detail screen agreeing across a grid of envelopes and clocks.
  const HALFWAY = { cycleLen: 14, daysLeft: 7 };

  describe('paceWarning — the rule itself', () => {
    // [A1] (P0) strict "<": daily room exactly half the daily plan stays quiet; a cent more spent warns.
    it('[A1] exactly half the daily plan left is quiet; a little less warns', () => {
      // available 140, 14-day cycle → plan $10/day, half = $5. 7 days left: $35 left == $5/day.
      expect(paceWarning({ spent: 105, target: 70, available: 140, over: false }, HALFWAY)).toBe(false);
      expect(paceWarning({ spent: 105.01, target: 70, available: 140, over: false }, HALFWAY)).toBe(true);
    });

    // [A2] (P0) an over-budget row never carries the pace warning (red already says it).
    it('[A2] over budget → no pace warning', () => {
      expect(paceWarning({ spent: 150, target: 50, available: 100, over: true }, HALFWAY)).toBe(false);
    });

    // [A3] (P0) ahead by exactly 50c stays quiet even with no room left.
    it('[A3] ahead by exactly $0.50 → quiet, even with almost nothing left per day', () => {
      expect(paceWarning({ spent: 50.5, target: 50, available: 51, over: false }, HALFWAY)).toBe(false);
      expect(paceWarning({ spent: 50.51, target: 50, available: 51, over: false }, HALFWAY)).toBe(true);
    });

    // [A4] (P1) last day (0 days left) divides by 1, not 0.
    it('[A4] 0 days left: room left counts as one day', () => {
      // available 140 → half plan $5. $6 left over "1" day → quiet; $4 left → warns.
      expect(paceWarning({ spent: 134, target: 100, available: 140, over: false }, { cycleLen: 14, daysLeft: 0 })).toBe(false);
      expect(paceWarning({ spent: 136, target: 100, available: 140, over: false }, { cycleLen: 14, daysLeft: 0 })).toBe(true);
    });
  });

  describe('pacePct — where the tick goes', () => {
    // [A5] (P0) the tick is the base target over the bar's scale, rounded and clamped.
    it('[A5] rounds and clamps to 0–100', () => {
      expect(pacePct(50, 200)).toBe(25);
      expect(pacePct(50, 160)).toBe(31);
      expect(pacePct(50, 40)).toBe(100);
      expect(pacePct(0, 100)).toBe(0);
    });
  });

  describe('budgets with the new rule', () => {
    // [A6] (P0) slightly ahead → not flagged.
    it('[A6] ahead of pace but with room → not urgent', () => {
      expect(budgetDetailFor({ budget: 100, posted: 74 }).statusLabel).toBe('On track for payday');
    });

    // [A7] (P0) pending spend counts toward the warning.
    it('[A7] pending pushes a budget over plan', () => {
      expect(budgetDetailFor({ budget: 100, posted: 70, pending: 15 }).statusLabel).toBe('Over plan — ease up');
    });

    // [A9] (P0) a rollover leftovers budget only warns on the envelope's daily room, not the base pace alone.
    it('[A9] $200 envelope: $150 spent is quiet, $180 spent warns', () => {
      expect(budgetDetailFor({ budget: 100, posted: 150, rollover: true, carryover: 100 }).statusLabel).toBe('On track for payday');
      expect(budgetDetailFor({ budget: 100, posted: 180, rollover: true, carryover: 100 }).statusLabel).toBe('Over plan — ease up');
    });

    // [A10] (P0) the tick and the fill meet when spend is exactly on the base pace, so the words
    // ("on plan") and the bar agree on rollover, past-overspend and spread rows.
    it('[A10] spent == base pace → the fill ends at the tick', () => {
      const cases: Partial<Budget>[] = [
        { rollover: true, carryover: 100 },
        { rollover: true, carryover: 60 },
        { rollover: true, carryover: -20 },
        { spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } },
        {},
      ];
      for (const extra of cases) {
        const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, ...extra });
        expect(row.targetPct).toBe(Math.round(row.postedPct));
      }
    });

    // [A11] (P1) income rows keep the elapsed tick (hidden anyway).
    it('[A11] income row: tick at elapsed', () => {
      const row = budgetRowFor({ budget: 5000, posted: 4900, pending: 0 }, SALARY);
      expect(row.targetPct).toBe(50);
      const d = budgetDetailFor({ budget: 5000, posted: 4900 }, HALFWAY, SALARY);
      expect(d.targetPct).toBe(50);
    });
  });

  describe('the row and the detail screen agree (WHIT-732 + WHIT-715)', () => {
    // [A13] (P0) across envelopes and clocks: "Over plan" on the detail is always in muted ink, and
    // the row and the detail put the tick in the same place.
    it('[A13] detail "Over plan" in muted colour, same tick on row and detail', () => {
      const envelopes: Partial<Budget>[] = [
        {},
        { rollover: true, carryover: 100 },
        { rollover: true, carryover: -30 },
        { spreadAdjustment: 60, spread: { amount: 120, cycles: 2, index: 1, adjustment: 60 } },
      ];
      const clocks = [{ cycleLen: 14, daysLeft: 13 }, HALFWAY, { cycleLen: 14, daysLeft: 1 }, { cycleLen: 30, daysLeft: 0 }];
      let warned = 0, quiet = 0;
      for (const extra of envelopes) for (const clock of clocks) for (let posted = 0; posted <= 200; posted += 10) {
        const b = budget({ id: 'coffee', budget: 100, posted, pending: 0, ...extra });
        const state = makeState({ budgets: [b], ...clock });
        const row = budgetViews(state).rows[0];
        const detail = budgetDetail(state, 'coffee')!;
        if (detail.statusLabel === 'Over plan — ease up') {
          expect(detail.statusColor).toBe(C.textInfo);
          warned++;
        } else if (!row.over) quiet++;
        expect(detail.targetPct).toBe(row.targetPct);
        const available = availableToSpend(b);
        expect(row.targetPct).toBe(pacePct(paceTarget(b, clock), available > 0 ? available : 100));
      }
      expect(warned).toBeGreaterThan(0);
      expect(quiet).toBeGreaterThan(0);
    });
  });
});

describe('WHIT-733 rollover row note', () => {
  // WHIT-733 QA — edges of the rollover note.
  // [A1]
  it('a rollover overspent this cycle despite past leftovers still gets the leftovers note', () => {
    const b = { budget: 100, posted: 200, pending: 0, rollover: true, carryover: 40 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(true);
    expect(row.note).toBe('Includes $40 past leftovers');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });

  // [A2]
  it('a rollover with past overspend but still under budget shows the amount', () => {
    const b = { budget: 200, posted: 20, pending: 0, rollover: true, carryover: -50 };
    const row = budgetRowFor(b);
    expect(row.over).toBe(false);
    expect(row.note).toBe('Includes $50 past overspend');
    expect(budgetDetailFor(b).carryoverLine).toBe(row.note);
  });
});

describe('WHIT-739 paid in one go', () => {
  // WHIT-739: a bill paid in full in one go (nothing left, one counting charge) has nothing to slow
  // down — no "over plan" on the detail. The calm detail status reads "On track for payday". A budget
  // used up by several charges still warns. (WHIT-745: the Budgets tab no longer ranks on pace, so it
  // no longer looks this up per row.)
  const MORTGAGE = cat({ id: 'mortgage', name: 'Mortgage', bucket: 'Living' });
  const MORTGAGE_CYCLE = { cycleLen: 30, daysLeft: 21 };
  const paidMortgage = budget({ id: 'mortgage', budget: 3667, posted: 3667, pending: 0 });
  const charge = (amount: number, over = {}) =>
    txn({ transaction_id: `m${amount}`, category: 'mortgage', amount: -amount, ...over });

  const mortgageDetail = (transactions: Transaction[], b: Partial<Budget> = {}) => budgetDetail(
    makeState({ categories: [MORTGAGE], budgets: [{ ...paidMortgage, ...b }], transactions, ...MORTGAGE_CYCLE }),
    'mortgage',
  )!;

  describe('paceWarning — paid in one go', () => {
    const row = { spent: 3667, target: 1100, available: 3667, over: false };
    it('one charge and $0 left → no warning', () => {
      expect(paceWarning({ ...row, oneCharge: true }, MORTGAGE_CYCLE)).toBe(false);
    });
    it('no one-charge flag and $0 left → still warns', () => {
      expect(paceWarning(row, MORTGAGE_CYCLE)).toBe(true);
    });
    it('one charge but $0.01 left, far ahead → still warns', () => {
      expect(paceWarning({ ...row, spent: 3666.99, oneCharge: true }, MORTGAGE_CYCLE)).toBe(true);
    });
  });

  describe('budgetDetail — paid in one go', () => {
    it('one counting charge of the full amount → "On track for payday", green', () => {
      const d = mortgageDetail([charge(3667)]);
      expect(d.statusLabel).toBe('On track for payday');
      expect(d.statusColor).toBe(C.good);
    });

    it('two charges that use it up → still "Over plan — ease up"', () => {
      const d = mortgageDetail([charge(1833.5, { transaction_id: 'a' }), charge(1833.5, { transaction_id: 'b' })]);
      expect(d.statusLabel).toBe('Over plan — ease up');
    });

    it('one counting charge plus one excluded charge → quiet', () => {
      const d = mortgageDetail([charge(3667), charge(10, { transaction_id: 'x', budget_excluded: true })]);
      expect(d.statusLabel).toBe('On track for payday');
    });

    it('over budget with one charge is still red', () => {
      const d = mortgageDetail([charge(3700)], { posted: 3700 });
      expect(d.statusLabel).toBe('Over budget — ease up');
      expect(d.statusColor).toBe(C.bad);
    });

    it('the calm default reads "On track for payday", not "On target — keep it up"', () => {
      const d = budgetDetailFor({ budget: 100, posted: 0 });
      expect(d.statusLabel).toBe('On track for payday');
    });
  });
});

describe('WHIT-741 Budgets polish', () => {
  // WHIT-741 — Budgets polish: "$X of $Y" has no "·" (pending is just counted in, WHIT-744), the "of" amount shows exact
  // cents and keeps its sign, a minus never wraps away from its "$" (word joiner U+2060), "of" never
  // wraps away from its amount (no-break space U+00A0), and a fully used budget hides its tick.
  const NBSP = ' ';
  const SIGN = '−⁠'; // real minus + word joiner
  const asSpaces = (s: string) => s.replace(/ /g, ' ');
  // $40.96 target − $700 payback slice → this cycle's budget is −$659.04.
  const payback = { budget: 40.96, posted: 617.75, pending: 0, spreadAdjustment: -700, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } };

  describe('a budget row reads "$X of $Y" with pending counted in (WHIT-741, WHIT-744)', () => {
    it('with pending: "$50 of $100", no "·"', () => {
      const row = budgetRowFor({ budget: 100, posted: 40, pending: 10 });
      expect(asSpaces(row.spentLabel)).toBe('$50 of $100');
      expect(row.spentLabel).not.toContain('·');
    });
  });

  describe('the "of" amount shows cents and keeps its sign (WHIT-741)', () => {
    it('nothing spent of $140.67 reads "$0 of $140.67", with a no-break space after "of"', () => {
      expect(budgetRowFor({ budget: 140.67, posted: 0, pending: 0 }).spentLabel).toMatch(/^\$0[  ]of \$140\.67$/);
    });

    it('a payback cycle reads "$617.75 of −$659.04"', () => {
      const row = budgetRowFor(payback);
      expect(row.spentLabel.endsWith(`of${NBSP}${SIGN}$659.04`)).toBe(true);
      expect(asSpaces(row.spentLabel).startsWith('$617.75 of')).toBe(true);
    });

    it('the detail screen reads "of −$659.04" with the same spacing', () => {
      expect(budgetDetailFor(payback).ofBudget).toBe(`of${NBSP}${SIGN}$659.04`);
    });
  });

  describe('fmtSignedExact keeps the minus with its number (WHIT-741)', () => {
    it('puts a word joiner between the minus and "$"', () => {
      expect(fmtSignedExact(-659.04)).toBe('−⁠$659.04');
      expect(fmtSignedExact(659.04)).toBe('$659.04');
      expect(fmtSignedExact(-0.004)).toBe('$0');
    });
  });

  describe('a fully used budget hides its tick (WHIT-741)', () => {
    it('row: tick only while something is left', () => {
      expect(budgetRowFor({ budget: 100, posted: 30, pending: 0 }).showTarget).toBe(true);
      expect(budgetRowFor({ budget: 100, posted: 100, pending: 0 }).showTarget).toBe(false);
      expect(budgetRowFor({ budget: 100, posted: 150, pending: 0 }).showTarget).toBe(false);
    });

    it('detail: tick only while something is left', () => {
      expect(budgetDetailFor({ budget: 100, posted: 30 }).showTarget).toBe(true);
      expect(budgetDetailFor({ budget: 100, posted: 100 }).showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 100, posted: 150 }).showTarget).toBe(false);
    });
  });

  // WHIT-741 QA — edges of the Budgets polish the main tests don't pin: the tick's "fully used"
  // boundary (float dust either side of a cent), pending counted in the spent line with cents, the
  // earning row never naming pending, rollover "of" with cents, and the word joiner on
  // large and dust-sized amounts. Calls the real budgetViews / budgetDetail / fmtSignedExact.

  describe('WHIT-741 QA — tick boundary', () => {
    // [A1] (P0) less than half a cent left reads "$0 left" → no tick, on the row and the detail.
    it('[A1] $0.004 left → no tick (row + detail)', () => {
      expect(budgetRowFor({ budget: 100, posted: 99.996, pending: 0 }).showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 100, posted: 99.996 }).showTarget).toBe(false);
    });

    // [A2] (P0) a cent left → the tick stays (row + detail).
    it('[A2] $0.01 left → tick stays (row + detail)', () => {
      expect(budgetRowFor({ budget: 100, posted: 99.99, pending: 0 }).showTarget).toBe(true);
      expect(budgetDetailFor({ budget: 100, posted: 99.99 }).showTarget).toBe(true);
    });

    // [A3] (P0) pending counts as spent: posted + pending = the whole budget → fully used, no tick.
    it('[A3] posted + pending use the whole budget → no tick', () => {
      expect(budgetRowFor({ budget: 100, posted: 60, pending: 40 }).showTarget).toBe(false);
      expect(budgetDetailFor({ budget: 100, posted: 60, pending: 40 }).showTarget).toBe(false);
    });

    // [A4] (P1) rollover: the available envelope (target + leftovers) decides "fully used", not the target.
    it('[A4] rollover row past its target but inside its leftovers keeps the tick', () => {
      const row = budgetRowFor({ budget: 100, posted: 120, pending: 0, rollover: true, carryover: 50 });
      expect(row.showTarget).toBe(true);
      expect(row.spentLabel).toBe(`$120 of${NBSP}$150`);
    });
  });

  describe('WHIT-741 QA — pending counted in spent', () => {
    // [A5] (P0) pending with cents is counted in spent, with no pending words (WHIT-744).
    it('[A5] pending $39.10 → "$89.10 of $200", no pending words', () => {
      const row = budgetRowFor({ budget: 200, posted: 50, pending: 39.1 });
      expect(row.spentLabel).not.toContain('pending');
      expect(row.spentLabel).toBe(`$89.10 of${NBSP}$200`);
    });

    // [A7] (P1) an over-budget row with pending has no "·" on the spent line.
    it('[A7] over budget + pending → no "·" on the spent line', () => {
      const row = budgetRowFor({ budget: 100, posted: 100, pending: 20 });
      expect(row.over).toBe(true);
      expect(row.spentLabel).not.toContain('·');
    });

    // [A8] (P1) earning rows never name pending, even with pending money.
    it('[A8] an income row with pending has no pending words', () => {
      const row = budgetRowFor({ budget: 5000, posted: 1000, pending: 300 }, cat(SALARY));
      expect(row.section).toBe('earning');
      expect(row.spentLabel).not.toContain('pending');
    });
  });

  describe('WHIT-741 QA — exact signed amounts', () => {
    // [A9] (P0) the word joiner sits between the minus and "$" on thousands too.
    it('[A9] fmtSignedExact(-1234.5) → minus, word joiner, "$1,234.50"', () => {
      expect(MINUS).toBe('−⁠');
      expect(fmtSignedExact(-1234.5)).toBe('−⁠$1,234.50');
    });

    // [A10] (P1) exactly −half a cent rounds to −$0.01, which is below zero → signed.
    it('[A10] fmtSignedExact(-0.006) is signed; -0.004 is not', () => {
      expect(fmtSignedExact(-0.006)).toBe(`${MINUS}$0.01`);
      expect(fmtSignedExact(-0.004)).not.toContain('−');
    });

    // [A11] (P1) detail "of" with cents on a positive non-whole budget.
    it('[A11] detail reads "of $140.67"', () => {
      expect(budgetDetailFor({ budget: 140.67, posted: 0 }).ofBudget).toBe(`of${NBSP}$140.67`);
    });

    // [A12] (P1) the "of" amount isn't rounded half up to a whole dollar any more.
    it('[A12] $99.50 budget reads "of $99.50", not "of $100"', () => {
      expect(budgetRowFor({ budget: 99.5, posted: 10, pending: 0 }).spentLabel).toBe(`$10 of${NBSP}$99.50`);
    });
  });
});

describe('WHIT-742 carryover cycles', () => {
  // WHIT-742 — a rollover budget's detail page lists the cycles its carryover came from, newest
  // first, plus one remainder line for anything older, so the lines add up to the carryover note.
  const cycle = (start: string, end: string, leftover: number, extra: object = {}) => ({
    start, end, target: 200, spent: 200 - leftover, leftover, settling: false, ...extra,
  });

  describe('budget detail lists the cycles behind a carryover (WHIT-742)', () => {
    it('Utilities: each past overspend cycle on its own line, settling ones marked', () => {
      const utilities = {
        budget: 200, posted: 100, rollover: true, carryover: -859, carryoverEarlier: 0,
        carryoverCycles: [
          cycle('2026-09-12', '2026-09-25', -519.6, { settling: true }),
          cycle('2026-08-29', '2026-09-11', -339.4),
        ],
      };
      const detail = budgetDetailFor(utilities);

      expect(detail.carryoverLine).toBe('Includes $859 past overspend');
      expect(detail.carryoverCycleLines).toHaveLength(2);
      expect(detail.carryoverCycleLines).toMatchObject([
        { label: '12 Sep – 25 Sep', amount: '−$520', settling: true },
        { label: '29 Aug – 11 Sep', amount: '−$339', settling: false },
      ]);
    });

    it('leftover cycles read as positive and an older legacy amount gets a "Before" line', () => {
      const leftovers = {
        budget: 200, posted: 50, rollover: true, carryover: 176, carryoverEarlier: 40,
        carryoverCycles: [cycle('2026-09-12', '2026-09-25', 136)],
      };
      expect(budgetDetailFor(leftovers).carryoverCycleLines).toMatchObject([
        { label: '12 Sep – 25 Sep', amount: '+$136', settling: false },
        { label: 'Before 12 Sep', amount: '+$40' },
      ]);
    });

    it('rebuilt cycles are flagged and the gap reads "Not matched to a cycle"', () => {
      const rebuilt = {
        budget: 200, posted: 50, rollover: true, carryover: -300, carryoverEarlier: -20,
        carryoverCycles: [cycle('2026-09-12', '2026-09-25', -280, { rebuilt: true })],
      };
      expect(budgetDetailFor(rebuilt).carryoverCycleLines).toMatchObject([
        { label: '12 Sep – 25 Sep', amount: '−$280', rebuilt: true },
        { label: 'Not matched to a cycle', amount: '−$20' },
      ]);
    });

    it('no saved cycles yet: the whole carryover is one "Earlier cycles" line', () => {
      const legacy = { budget: 200, posted: 50, rollover: true, carryover: -859, carryoverEarlier: -859, carryoverCycles: [] };
      expect(budgetDetailFor(legacy).carryoverCycleLines).toMatchObject([
        { label: 'Earlier cycles', amount: '−$859' },
      ]);
    });

    it('a budget without rollover lists no cycles', () => {
      expect(budgetDetailFor({ budget: 100, posted: 40 }).carryoverCycleLines).toEqual([]);
    });
  });

  // WHIT-742 QA — edges of the cycle lines under a rollover carryover on the budget detail page.

  describe('WHIT-742 QA: carryover cycle lines', () => {
    // [C1] (P0) The wire fields reach the model.
    it('toBudget maps carryover_cycles and carryover_earlier from the server row', () => {
      const cycles = [{ ...cycle('2026-09-12', '2026-09-25', -520), settling: true }];
      const b = toBudget('x', { target: 200, posted: 0, pending: 0, rollover: true, carryover: -879, carryover_cycles: cycles, carryover_earlier: -359 });
      expect(b.carryoverCycles).toEqual(cycles);
      expect(b.carryoverEarlier).toBe(-359);
    });

    // [C2] (P0) The remainder line shows from 50c up, and not below.
    it('a remainder under 50c gets no line; exactly 50c does', () => {
      const base = { budget: 200, posted: 0, rollover: true, carryover: -520.4, carryoverCycles: [cycle('2026-09-12', '2026-09-25', -520)] };
      expect(budgetDetailFor({ ...base, carryoverEarlier: -0.4 }).carryoverCycleLines).toHaveLength(1);
      expect(budgetDetailFor({ ...base, carryover: -520.5, carryoverEarlier: -0.5 }).carryoverCycleLines).toMatchObject([
        { label: '12 Sep – 25 Sep' }, { label: 'Before 12 Sep', amount: '−$1' },
      ]);
    });

    // [C3] (P1) No note → no lines, even when cycles cancel each other out.
    it('a carryover that nets to under 50c shows neither the note nor any cycle lines', () => {
      const detail = budgetDetailFor({
        budget: 200, posted: 0, rollover: true, carryover: 0.2, carryoverEarlier: 0.2,
        carryoverCycles: [cycle('2026-09-12', '2026-09-25', 100), cycle('2026-08-29', '2026-09-11', -100)],
      });
      expect(detail.carryoverLine).toBe('');
      expect(detail.carryoverCycleLines).toEqual([]);
    });

    // [C4] (P1) "Before" names the OLDEST listed cycle, even with a settling one in front; keys unique.
    it('the remainder line is dated from the oldest cycle and every line has its own key', () => {
      const detail = budgetDetailFor({
        budget: 200, posted: 0, rollover: true, carryover: -100, carryoverEarlier: -60,
        carryoverCycles: [
          cycle('2026-09-26', '2026-10-09', 20, { settling: true }),
          cycle('2026-09-12', '2026-09-25', -40),
          cycle('2026-08-29', '2026-09-11', -20),
        ],
      });
      const lines = detail.carryoverCycleLines;
      expect(lines.map((l) => l.label)).toEqual(['26 Sep – 9 Oct', '12 Sep – 25 Sep', '29 Aug – 11 Sep', 'Before 29 Aug']);
      expect(lines.map((l) => l.amount)).toEqual(['+$20', '−$40', '−$20', '−$60']);
      expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    });

    // [C5] (P1) A legacy budget with no cycle fields at all (old cached data) still lists one line.
    it('a rollover budget missing both new fields falls back to no cycles and no remainder', () => {
      const detail = budgetDetailFor({ budget: 200, posted: 0, rollover: true, carryover: -859, carryoverCycles: undefined, carryoverEarlier: undefined });
      expect(detail.carryoverLine).toBe('Includes $859 past overspend');
      expect(detail.carryoverCycleLines).toEqual([]);
    });

    // [C6] (P0) Nothing changes on the Budgets tab row.
    it('the Budgets tab row text carries none of the cycle lines', () => {
      const c = cat();
      const b = budget({
        id: c.id, budget: 200, posted: 0, pending: 0, rollover: true, carryover: -859, carryoverEarlier: -339,
        carryoverCycles: [cycle('2026-09-12', '2026-09-25', -520)],
      });
      const text = budgetRowsFor([c], [b]).map(rowText).join(' ');
      expect(text).toContain('Includes $859 past overspend');
      expect(text).not.toMatch(/12 Sep|−\$520|Before|Earlier cycles/);
    });
  });
});

describe('WHIT-745 only over-budget rows move up', () => {
  // WHIT-745 QA — over-first-only edges: exactly-at-limit, a cent over, pending tipping a row over,
  // a rollover buffer keeping a past-target row under, and a behind-pace parent lifted only by its over sub.
  const shopping = cat({ id: 'shopping', name: 'Shopping' });

  // [A1] (P0) a budget used to the exact cent is not over, so it keeps its category place.
  it('does not lift a row spent exactly to its budget', () => {
    const rows = budgetRowsFor([GROCERIES, DINING], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 100, pending: 0 }),
    ]);
    expect(rows.find((r) => r.id === 'dining')!.over).toBe(false);
    expect(rowIds(urgentFirst(rows))).toEqual(['groceries', 'dining']);
  });

  // [A2] (P0) one cent over budget is over and moves to the top.
  it('lifts a row one cent over its budget', () => {
    const rows = budgetRowsFor([GROCERIES, DINING], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 100.01, pending: 0 }),
    ]);
    expect(rowIds(urgentFirst(rows))).toEqual(['dining', 'groceries']);
  });

  // [A3] (P1) pending charges count: posted under budget plus pending over it lifts the row.
  it('lifts a row that pending charges push over budget', () => {
    const rows = budgetRowsFor([GROCERIES, DINING], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 90, pending: 20 }),
    ]);
    expect(rowIds(urgentFirst(rows))).toEqual(['dining', 'groceries']);
  });

  // [A4] (P1) a rollover buffer: spent past the base target but within what's available is not over.
  it('does not lift a rollover row spent past its target but within its buffer', () => {
    const rows = budgetRowsFor([GROCERIES, DINING], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 130, pending: 0, rollover: true, carryover: 50 }),
    ]);
    expect(rowIds(urgentFirst(rows))).toEqual(['groceries', 'dining']);
  });

  // [A5] (P0) a behind-pace parent is lifted only because its sub is over; another behind-pace
  // family stays in category order behind an on-pace one.
  it('lifts a family by its over sub, not by its behind-pace parent', () => {
    const rows = budgetRowsFor([GROCERIES, shopping, COFFEE, LATTE], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'shopping', budget: 100, posted: 90, pending: 0 }),
      budget({ id: 'coffee', budget: 200, posted: 180, pending: 0 }),
      budget({ id: 'latte', budget: 20, posted: 25, pending: 0 }),
    ]);
    const ordered = urgentFirst(rows);
    expect(rowIds(ordered)).toEqual(['coffee', 'latte', 'groceries', 'shopping']);
    expect(ordered.map((r) => r.depth)).toEqual([0, 1, 0, 0]);
  });
});

describe('WHIT-750 no row pace flag', () => {
  // WHIT-750 — budget rows no longer carry a "spending too fast" flag; nothing on the Budgets tab
  // read it. The detail screen still warns with the shared pace rule, and stays calm for a bill
  // paid in one go.
  const PACE_FLAG = 'behind' + 'Pace';

  const ROW_FIELDS = [
    'id', 'name', 'color', 'icon', 'chipBg',
    'spentLabel', 'remainAmount', 'remainLabel', 'remainColor',
    'postedPct', 'pendingPct', 'targetPct', 'postedColor',
    'pendingTint', 'over', 'note', 'depth', 'parentId',
    'section', 'showTarget', 'unspent',
  ].sort();

  describe('budget rows carry no pace flag (WHIT-750)', () => {
    it('a fast-spending row has exactly the other row fields, and no pace flag', () => {
      // Halfway through: $80 spent of $100 → past the $50 pace line, not over.
      const fast = budgetRowFor({ budget: 100, posted: 70, pending: 10 });
      expect(PACE_FLAG in fast).toBe(false);
      expect(Object.keys(fast).sort()).toEqual(ROW_FIELDS);
      expect(fast.over).toBe(false);
      expect(fast.targetPct).toBe(50);
      expect(fast.section).toBe('spending');
    });

    it('an earning row has no pace flag either', () => {
      const income = budgetRowFor({ budget: 5000, posted: 1000 }, SALARY);
      expect(PACE_FLAG in income).toBe(false);
      expect(Object.keys(income).sort()).toEqual(ROW_FIELDS);
      expect(income.section).toBe('earning');
    });
  });

  describe('budget detail still warns about spending too fast (WHIT-750)', () => {
    it('past the pace line → "Over plan — ease up"; under it → calm', () => {
      const fast = budgetDetailFor({ budget: 100, posted: 80 });
      expect(fast.statusLabel).toBe('Over plan — ease up');
      expect(fast.statusColor).toBe(C.textInfo);

      const calm = budgetDetailFor({ budget: 100, posted: 20 });
      expect(calm.statusLabel).toBe('On track for payday');
    });
  });

  // WHIT-750 QA — row-only pace cases removed with the row flag, re-pinned at the detail screen.
  describe('detail pace words for cases the row flag used to cover (WHIT-750 QA)', () => {
    // [A1] (P0) exactly on pace ($50 of $100, halfway) → calm, both with and without pending.
    it('[A1] exactly on the pace line stays calm', () => {
      expect(budgetDetailFor({ budget: 100, posted: 50 }).statusLabel).toBe('On track for payday');
      expect(budgetDetailFor({ budget: 100, posted: 40, pending: 10 }).statusLabel).toBe('On track for payday');
    });
  });
});
