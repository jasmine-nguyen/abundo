// WHIT-707 QA — adversarial edges on the Budgets tab row text (budgetViews): the payday label's
// weekday/date boundary, the spread link vs the quiet "over budget" line, pending wording
// thresholds, Spending-before-Earning ordering with nested income, and the date helpers.
// Runs under TZ=Australia/Melbourne (npm test), so the daylight-saving cases are real.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { C } from '../theme';
import { nextPaydayISO } from '../payCycle';
import { formatWeekdayShort } from '../dateutil';
import { makeState, cat, budget } from './factory';

const salary = cat({ id: 'salary', name: 'Salary', color: '#35d9a0', bucket: 'Income' });
const bonus = cat({ id: 'bonus', name: 'Bonus', color: '#35d9a0', bucket: 'Income', parent: 'salary' });
const coffee = cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' });
const latte = cat({ id: 'latte', name: 'Lattes', bucket: 'Lifestyle', parent: 'coffee' });
const rent = cat({ id: 'rent', name: 'Rent', bucket: 'Living' });

const incomeRow = (daysLeft: number, nextPayday: string) => budgetViews({
  ...makeState({ categories: [salary], budgets: [budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 })], cycleLen: 14, daysLeft }),
  nextPayday,
}).rows[0];

const spendRow = (over: Parameters<typeof budget>[0]) => budgetViews(makeState({
  categories: [coffee], budgets: [budget({ id: 'coffee', ...over })], cycleLen: 14, daysLeft: 7,
})).rows[0];

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

describe('over budget: spread link vs quiet line (decision 2)', () => {
  // [A6] (P0) an active spread can't START another → quiet muted text, no link.
  it('[A6] over with an active spread → "$X over budget", muted, no prefill', () => {
    const row = spendRow({
      budget: 100, posted: 130, pending: 0, spreadAdjustment: -10,
      spread: { amount: 60, cycles: 3, index: 2, adjustment: -10 },
    });
    expect(row.over).toBe(true);
    expect(row.paceLabel).toBe('$40 over budget');
    expect(row.paceColor).toBe(C.textInfo);
    expect(row.spreadPrefill).toBeNull();
    expect(row.remainColor).toBe(C.bad); // rose stays on the amount
  });

  // [A7] (P1) a sub-cent overshoot can't spread $0 → quiet text, not the link.
  it('[A7] sub-cent overshoot → quiet line, no prefill', () => {
    const row = spendRow({ budget: 100, posted: 100.004, pending: 0 });
    expect(row.over).toBe(true);
    expect(row.spreadPrefill).toBeNull();
    expect(row.paceLabel).not.toBe('Spread it over pay cycles →');
    expect(row.paceColor).not.toBe(C.bad);
  });

  // [A8] (P0) the link's prefill counts pending too (the same overspend the detail screen uses).
  it('[A8] over with pending → prefill = posted + pending − budget, pending named', () => {
    const row = spendRow({ budget: 100, posted: 90, pending: 25 });
    expect(row.paceLabel).toBe('Spread it over pay cycles →');
    expect(row.spreadPrefill).toBe(15);
    expect(row.spentLabel).toBe('$115 spent of $100 · $25 pending');
  });

  // [A9] (P0) under budget → never a link (no prefill), even if over pace.
  it('[A9] over pace but under budget → no prefill, amber pace line', () => {
    const row = spendRow({ budget: 100, posted: 90, pending: 0 }); // target 50
    expect(row.over).toBe(false);
    expect(row.spreadPrefill).toBeNull();
    expect(row.paceLabel).toBe('$40 over pace');
    expect(row.paceColor).toBe(C.warn);
  });

  // [A10] (P1) exactly at the limit is not over → no link, "left" $0.
  it('[A10] spent exactly = budget → not over, no prefill', () => {
    const row = spendRow({ budget: 100, posted: 100, pending: 0 });
    expect(row.over).toBe(false);
    expect(row.spreadPrefill).toBeNull();
    expect(row.paceLabel).not.toContain('over budget');
  });

  // [A11] (P1) rollover drained into a deficit, over → quiet text with the exact overspend.
  it('[A11] rollover with a borrowed buffer, over → quiet "$X over budget"', () => {
    const row = spendRow({ budget: 100, posted: 95, pending: 0, rollover: true, carryover: -20 });
    expect(row.over).toBe(true);
    expect(row.paceLabel).toBe('$15 over budget');
    expect(row.paceColor).toBe(C.textInfo);
    expect(row.spreadPrefill).toBeNull();
    expect(row.carryoverLabel).toBe('$20 borrowed');
  });
});

describe('pending wording threshold', () => {
  // [A12] (P1) a sub-cent pending float is noise → no "pending" breakout.
  it('[A12] pending 0.004 → no pending words', () => {
    expect(spendRow({ budget: 100, posted: 40, pending: 0.004 }).spentLabel).not.toContain('pending');
  });

  // [A13] (P1) one cent pending is real → named with cents.
  it('[A13] pending 0.01 → named', () => {
    expect(spendRow({ budget: 100, posted: 40, pending: 0.01 }).spentLabel).toBe('$40.01 spent of $100 · $0.01 pending');
  });

  // [A14] (P1) rollover envelope: "of" shows the available envelope, pending still named.
  it('[A14] rollover with carryover → "of" the envelope, plus pending', () => {
    const row = spendRow({ budget: 100, posted: 30, pending: 20, rollover: true, carryover: 50 });
    expect(row.spentLabel).toBe('$50 spent of $150 · $20 pending');
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
  // [A17] (P1) late evening the night before DST starts (4 Oct 2026) still counts local days.
  it('[A17] nextPaydayISO from 23:30 local on 3 Oct + 1 → 4 Oct', () => {
    expect(nextPaydayISO(1, new Date(2026, 9, 3, 23, 30))).toBe('2026-10-04');
    expect(nextPaydayISO(1, new Date(2026, 9, 4, 0, 15))).toBe('2026-10-05');
  });

  // [A18] (P1) across DST end (5 Apr 2026) the date doesn't slip a day.
  it('[A18] nextPaydayISO across DST end', () => {
    expect(nextPaydayISO(3, new Date(2026, 3, 4, 23, 59))).toBe('2026-04-07');
  });

  // [A19] (P2) weekday on the DST-change days, and garbage input → ''.
  it('[A19] formatWeekdayShort on DST days and garbage', () => {
    expect(formatWeekdayShort('2026-04-05')).toBe('Sun');
    expect(formatWeekdayShort('2026-10-05')).toBe('Mon');
    expect(formatWeekdayShort('not-a-date')).toBe('');
  });
});
