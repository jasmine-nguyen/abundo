// Shared seed for Budgets-tab screen tests over the fake server: one spend category and a
// 14-day cycle with the server's authoritative days_left (7 → halfway, so pace = half the budget).
import type { installFakeServer } from './fakeServer';

export const COFFEE = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 };

export function seedBudgetsTab(
  server: ReturnType<typeof installFakeServer>,
  budgets: Record<string, unknown>,
  categories: unknown[] = [COFFEE],
  daysLeft = 7,
) {
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-09-26', days_left: daysLeft });
  server.seed('/categories', categories);
  server.seed('/budgets', budgets);
}
