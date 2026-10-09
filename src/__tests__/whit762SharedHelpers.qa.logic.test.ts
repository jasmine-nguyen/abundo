// WHIT-762 QA — the shared homes the copies now point at: the date
// headings (dateLabel via groupTransactionsByDate / transactionGroups) and the one
// categoryColorHash the category palette uses. Pins exact output so a drift in the shared helper
// shows up here.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { groupTransactionsByDate, transactionGroups } from '../context';
import { chartCategoryColor } from '../chartColors';
import { makeState, cat, txn } from './factory';

afterEach(() => {
  jest.useRealTimers();
});

describe('dateLabel through groupTransactionsByDate', () => {
  // [A12]
  it('a future-dated charge gets a weekday label, not Today/Yesterday', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12, 0) });
    expect(groupTransactionsByDate([txn({ date: '2026-10-07' })])[0].label).toBe('Wed 7 Oct');
  });
});

describe('transactionGroups (now built on groupTransactionsByDate)', () => {
  // [A14]
  it('the Uncategorized tab groups only unmapped charges, under the same headings', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12, 0) });
    const s = makeState({
      categories: [cat()],
      transactions: [
        txn({ transaction_id: 'filed', date: '2026-10-06', category: 'coffee' }),
        txn({ transaction_id: 'loose', date: '2026-10-06', category: null }),
        txn({ transaction_id: 'old', date: '2026-10-05', category: 'raw_code' }),
      ],
    });
    const pick = (tab: 'all' | 'uncategorized') =>
      transactionGroups(s, tab).map((g) => [g.label, g.items.map((t) => t.transaction_id)]);
    expect(pick('all')).toEqual([['Today', ['filed', 'loose']], ['Yesterday', ['old']]]);
    expect(pick('uncategorized')).toEqual([['Today', ['loose']], ['Yesterday', ['old']]]);
  });
});

describe('custom category colour (shared categoryColorHash)', () => {
  // [A17]
  it("a custom category's colour is unchanged", () => {
    expect(chartCategoryColor('my-custom-cat')).toBe('#4ccda3');
  });
});
