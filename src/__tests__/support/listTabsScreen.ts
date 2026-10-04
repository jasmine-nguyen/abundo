// WHIT-713 — shared setup for the Accounts and Transactions stale-line suites: one cached row, and a
// reset that pins the clock to 9:40am Melbourne, resets auth/probe/router and seeds categories.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { pinToday } from './clock';
import { txn } from '../factory';
import { resetAppProbe } from './renderWithApp';
import { resetAuth } from './authMock';
import { resetRouter } from './routerMock';
import type { installFakeServer } from './fakeServer';
import { GROCERIES_RECORD } from './categories';

export const LIST_ROW = txn({ amount: -42, account_name: 'ANZ' });

export function resetListTabs(server: ReturnType<typeof installFakeServer>) {
  pinToday(new Date('2026-09-18T09:40:00+10:00'));
  resetAuth();
  resetAppProbe();
  resetRouter();
  server.seed('/categories', [GROCERIES_RECORD]);
}
