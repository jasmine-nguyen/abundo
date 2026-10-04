// Shared Budgets-tab fixtures. seedBudgets: a coffee budget on a 30-day cycle (each part
// overridable). seedBudgetsTab: a 14-day cycle with the server's authoritative days_left
// (7 → halfway, so pace = half the budget).
import type { installFakeServer } from './fakeServer';
import { budgetViews, budgetDetail } from '../../context';
import { makeState, cat, budget } from '../factory';
import { COFFEE } from './categories';

export const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };
export const BUDGET_PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };

type Seed = { payCycle?: object; budgets?: object; categories?: object };

export function seedBudgets(server: ReturnType<typeof installFakeServer>, seed: Seed = {}) {
  server.seed('/budgets', seed.budgets ?? BUDGETS);
  server.seed('/categories', seed.categories ?? [COFFEE]);
  server.seed('/paycycle', seed.payCycle ?? BUDGET_PAY_CYCLE);
}

export function seedBudgetsTab(
  server: ReturnType<typeof installFakeServer>,
  budgets: Record<string, unknown>,
  categories: unknown[] = [COFFEE],
  daysLeft = 7,
  lastPayDate = '2026-09-26',
) {
  seedBudgets(server, { budgets, categories, payCycle: { length: 14, last_pay_date: lastPayDate, days_left: daysLeft } });
}

// The coffee budget's row on the same halfway cycle, so a $100 budget's pace target is $50.
export const budgetRowFor = (b: object) =>
  budgetViews(
    makeState({ categories: [cat()], budgets: [budget({ id: 'coffee', ...b })], cycleLen: 14, daysLeft: 7 }),
  ).rows[0];

// The coffee budget's detail (no pending unless given), halfway through a 14-day cycle by default.
export const budgetDetailFor = (b: object, clock = { cycleLen: 14, daysLeft: 7 }, c = cat()) =>
  budgetDetail(makeState({ categories: [c], budgets: [budget({ id: 'coffee', pending: 0, ...b })], ...clock }), 'coffee')!;

// Every text field of a budget row, joined, for "no row says X" checks.
export const rowText = (row: object) => Object.values(row).filter((v) => typeof v === 'string').join(' | ');
