// Shared Budgets-tab fixtures: one spend category and a 14-day cycle with the server's
// authoritative days_left (7 → halfway, so pace = half the budget).
import type { installFakeServer } from './fakeServer';
import { budgetViews } from '../../context';
import { makeState, cat, budget } from '../factory';
import { COFFEE } from './categories';

export function seedBudgetsTab(
  server: ReturnType<typeof installFakeServer>,
  budgets: Record<string, unknown>,
  categories: unknown[] = [COFFEE],
  daysLeft = 7,
  lastPayDate = '2026-09-26',
) {
  server.seed('/paycycle', { length: 14, last_pay_date: lastPayDate, days_left: daysLeft });
  server.seed('/categories', categories);
  server.seed('/budgets', budgets);
}

// The coffee budget's row on the same halfway cycle, so a $100 budget's pace target is $50.
export const budgetRowFor = (b: object) =>
  budgetViews(
    makeState({ categories: [cat()], budgets: [budget({ id: 'coffee', ...b })], cycleLen: 14, daysLeft: 7 }),
  ).rows[0];
