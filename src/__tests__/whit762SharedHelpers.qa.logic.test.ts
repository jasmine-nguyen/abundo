// WHIT-762 QA — the shared homes the copies now point at: the date
// headings (dateLabel via groupTransactionsByDate / transactionGroups), transactionView's fmt2
// amount, and the one categoryColorHash both colour files use. Pins exact output so a drift in
// the shared helper shows up here.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { groupTransactionsByDate, transactionGroups, transactionView } from '../context';
import { colorForCategory } from '../categoryColors';
import { makeState, cat, txn } from './factory';

afterEach(() => {
  jest.useRealTimers();
});

describe('dateLabel through groupTransactionsByDate', () => {
  // [A11]
  it('labels across a year boundary: 1 Jan → Today, 31 Dec → Yesterday, 30 Dec → weekday + day month', () => {
    jest.useFakeTimers({ now: new Date(2027, 0, 1, 23, 59) });
    const labels = groupTransactionsByDate([
      txn({ transaction_id: 'a', date: '2027-01-01' }),
      txn({ transaction_id: 'b', date: '2026-12-31' }),
      txn({ transaction_id: 'c', date: '2026-12-30' }),
    ]).map((g) => g.label);
    expect(labels).toEqual(['Today', 'Yesterday', 'Wed 30 Dec']);
  });

  // [A12]
  it('a future-dated charge gets a weekday label, not Today/Yesterday', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12, 0) });
    expect(groupTransactionsByDate([txn({ date: '2026-10-07' })])[0].label).toBe('Wed 7 Oct');
  });

  // [A13]
  it('keeps input order and merges same-day rows under one heading', () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12, 0) });
    const groups = groupTransactionsByDate([
      txn({ transaction_id: 'a', date: '2026-10-01' }),
      txn({ transaction_id: 'b', date: '2026-10-06' }),
      txn({ transaction_id: 'c', date: '2026-10-01' }),
    ]);
    expect(groups.map((g) => [g.label, g.items.map((t) => t.transaction_id)])).toEqual([
      ['Thu 1 Oct', ['a', 'c']],
      ['Today', ['b']],
    ]);
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

describe('transactionView amountLabel (fmt2)', () => {
  // [A15]
  it('signs and formats to exact cents', () => {
    const label = (amount: number) => transactionView(makeState({ categories: [cat()] }), txn({ amount })).amountLabel;
    expect(label(-1234.5)).toBe('-$1,234.50');
    expect(label(2500)).toBe('+$2,500.00');
    expect(label(0)).toBe('+$0.00');
    expect(label(-0.004)).toBe('-$0.00');
  });
});

describe('custom category colour (shared categoryColorHash)', () => {
  // [A17]
  it("a custom category's colour is unchanged", () => {
    expect(colorForCategory('my-custom-cat')).toBe('#039db5');
  });
});
