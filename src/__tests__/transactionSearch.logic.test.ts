// The Transactions-tab search matcher: it searches the fields the user SEES on a row —
// merchant + description + category label — plus the amount. Pure over { category }.
import { describe, it, expect } from '@jest/globals';
import { transactionMatchesSearch } from '../context';
import { makeState, cat, txn } from './factory';

const cats = [
  cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' }),
  cat({ id: 'groceries', name: 'Groceries', bucket: 'Living' }),
];
const s = makeState({ categories: cats });
const match = (t: Parameters<typeof transactionMatchesSearch>[1], q: string) => transactionMatchesSearch(s, t, q);

describe('transactionMatchesSearch', () => {
  it('matches the merchant name, case-insensitively', () => {
    const t = txn({ merchant_name: 'Woolworths', description: 'WOOLWORTHS METRO', category: 'groceries' });
    expect(match(t, 'wool')).toBe(true);
    expect(match(t, 'WOOL')).toBe(true);
    expect(match(t, 'coles')).toBe(false);
  });

  it('matches text in the raw description even when the merchant label is cleaned', () => {
    const t = txn({ merchant_name: 'Uber', description: 'UBER *TRIP HELP.UBER.COM', category: 'groceries' });
    expect(match(t, 'trip')).toBe(true);
  });

  it('matches the category name (not just the merchant)', () => {
    const t = txn({ merchant_name: 'ST ALi', description: 'ST ALI', category: 'coffee' });
    expect(match(t, 'cafes')).toBe(true);   // from the category label "Cafes & Coffee"
    expect(match(t, 'st ali')).toBe(true);  // and still the merchant
  });

  it('matches the "Uncategorized" and "Income" pseudo-labels', () => {
    expect(match(txn({ merchant_name: 'Mystery', category: null }), 'uncategorized')).toBe(true);
    expect(match(txn({ merchant_name: 'Payroll', category: 'income' }), 'income')).toBe(true);
  });

  it('matches the amount, tolerating $ and , punctuation in the query', () => {
    const t = txn({ merchant_name: 'Shop', category: 'groceries', amount: -42.5 });
    expect(match(t, '42')).toBe(true);
    expect(match(t, '42.50')).toBe(true);
    expect(match(t, '$42')).toBe(true);
    const big = txn({ merchant_name: 'Rent', category: 'groceries', amount: -1234 });
    expect(match(big, '1,234')).toBe(true);
    expect(match(t, '999')).toBe(false);
  });

  it('an empty / whitespace query matches everything (unfiltered list)', () => {
    const t = txn({ merchant_name: 'Anything', category: 'groceries' });
    expect(match(t, '')).toBe(true);
    expect(match(t, '   ')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    const t = txn({ merchant_name: 'Woolworths', description: 'WOOLWORTHS', category: 'groceries', amount: -12.5 });
    expect(match(t, 'zzz')).toBe(false);
  });
});
