// ABU-65: every per-account display rule lives in src/accountDisplay.ts so the Accounts tab and the
// account detail screen can't drift. The subtitle is a useful fact, not a count of loaded rows:
// cards → credit left; everyday → when money last went out; home loan → its payoff line.
import { it, expect, afterEach, jest } from '@jest/globals';
import { accountSubtitle } from '../accountDisplay';
import type { AccountBalance } from '../api';
import { pinToday } from './support/clock';

const bal = (over: Partial<AccountBalance>) => ({
  account_id: 'a1', amount: 100, available_balance: 100, currency: 'AUD',
  as_of: '2026-10-16T09:00:00Z', account_type: 'checking', ...over,
}) as AccountBalance;

const summary = (lastSpendDate: string | null) => ({ id: 'a1', name: 'Up Spending', count: 3, lastSpendDate });

afterEach(() => { jest.useRealTimers(); });

it.each([
  ['a card with credit left → credit available', summary('2026-10-16'), bal({ amount: -230, available_balance: 4549.4, account_type: 'unknown' }), null, '$4,549 available'],
  ['everyday, spent today', summary('2026-10-16'), bal({}), null, 'Last spend today'],
  ['everyday, spent yesterday', summary('2026-10-15'), bal({}), null, 'Last spend yesterday'],
  ['everyday, spent earlier', summary('2026-10-13'), bal({}), null, 'Last spend Tue 13 Oct'],
  ['everyday, nothing spent in the loaded rows', summary(null), bal({}), null, 'No recent spending'],
  ['home loan with a payoff line', summary('2026-10-16'), bal({ amount: -250000, available_balance: 0, account_type: 'mortgage' }), 'Next milestone: $50,000 to go', 'Next milestone: $50,000 to go'],
  ['home loan without a payoff plan', summary(null), bal({ amount: -250000, available_balance: 0, account_type: 'mortgage' }), null, 'Home loan · payoff inside'],
])('accountSubtitle: %s', (_name, s, b, loanLine, expected) => {
  pinToday(new Date(2026, 9, 16, 12, 0, 0));
  expect(accountSubtitle({ summary: s, bal: b, loanLine })).toBe(expected);
});