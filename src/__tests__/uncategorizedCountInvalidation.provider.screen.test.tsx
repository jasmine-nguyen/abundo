// WHIT-501 / WHIT-342 / WHIT-540 — every write that CHANGES which charges are uncategorized, or
// what a category's drill-in list totals, must refresh those caches:
//   - ['uncategorizedCount'] is the whole-history tally behind the tab badge, the nav-bar dot and
//     "All caught up". staleTime is 5min, so a missed invalidate shows a stale badge for 5 minutes.
//   - ['categoryTransactions'] is the drill-in list and its header total. staleTime is 45s, so a
//     missed invalidate lets the drill disagree with the Insights card it was opened from.
// Fail-on-revert: drop the invalidateQueries line at any write site and its row fails.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';
import { colesTxn as txn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const RULE: Rule = { id: 'r1', pattern: 'COLES', categoryId: 'groceries', isNew: false, field: 'description', operator: 'contains' };
const RULE_RECORD = { id: 'r1', value: 'COLES', categoryId: 'groceries', field: 'description', operator: 'contains' } as const;

beforeEach(() => {
  queryClient.clear();
  server.seed('/rules', [{ ...RULE_RECORD }]);
});
afterEach(() => { queryClient.clear(); });

type Ctx = ReturnType<typeof useAppContext>;
const confirm = (c: Ctx) => c.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' });

it.each<[string, Transaction[], Rule[], ((c: Ctx) => void) | null, (c: Ctx) => Promise<unknown>, string[]]>([
  ["applyCategory('one')", [txn()], [], confirm, (c) => c.applyCategory('one'), ['uncategorizedCount', 'categoryTransactions']],
  ["applyCategory('all')", [txn(), txn({ transaction_id: 't2', description: 'COLES 0999 MELBOURNE' })], [], confirm, (c) => c.applyCategory('all'), ['uncategorizedCount']],
  ['applyCategoryToMany', [txn(), txn({ transaction_id: 't2' })], [], null, (c) => c.applyCategoryToMany(['t1', 't2'], 'groceries'), ['uncategorizedCount']],
  // Its charges fall back to Uncategorized, so the tally RISES.
  ['deleteCategory', [txn({ category: 'groceries' })], [], null, (c) => c.deleteCategory('groceries'), ['uncategorizedCount']],
  // Excluding a charge drops it from the drill's contributing total, as it does from the card.
  ['applyTransactionEdit({ budget_excluded: true })', [txn()], [], null, (c) => c.applyTransactionEdit('t1', { budget_excluded: true }), ['categoryTransactions']],
  // WHIT-540: editing or deleting a rule re-files / undoes the charges it already filed.
  ['updateRule', [txn()], [RULE], null, (c) => c.updateRule('r1', 'COLES SYDNEY', 'groceries'), ['uncategorizedCount']],
  ['deleteRule', [txn()], [RULE], null, (c) => c.deleteRule('r1'), ['uncategorizedCount']],
])('%s refreshes the caches it changes', async (_writer, transactions, rules, before, run, keys) => {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...GROCERIES }]);
  queryClient.setQueryData(['rules'], rules);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  if (before) act(() => before(result.current));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await run(result.current); });

  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(keys));
  spy.mockRestore();
});
