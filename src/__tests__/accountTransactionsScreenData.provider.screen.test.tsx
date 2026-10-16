// ABU-67 — the account page's own paged history (useAccountTransactionsScreenData) under the REAL
// AppProvider over the fake server. An older row reached only through the account page's Load More
// lives in no other cache, so these prove it is a first-class copy: the resolver finds it, a
// re-file and a delete reach it, and each account pages its own history.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useAppContext } from '../context';
import { useAccountTransactionsScreenData, useTransactionResolver } from '../queries';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { resetAuth } from './support/authMock';
import { useTestQueryClient } from './support/renderWithQueries';
import { queriesAppWrapper as wrapper } from './support/renderWithApp';
import { GROCERIES_RECORD } from './support/categories';
import { colesTxn } from './factory';

const server = installFakeServer();
useTestQueryClient();

const NEWEST = colesTxn({ transaction_id: 'newest', date: '2026-07-01', authorized_date: '2026-07-01' });
const OLDER = colesTxn({ transaction_id: 'older', date: '2024-03-04', authorized_date: '2024-03-04' });

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [GROCERIES_RECORD]);
  // The fake server ignores the query string, so the all-accounts feed sees this page too — it
  // never holds OLDER, which only the account page's second page brings in.
  seedFeedPage(server, '/transactions/feed', [NEWEST], 'c1');
});

function useAccountPage({ id }: { id: string }) {
  return { app: useAppContext(), page: useAccountTransactionsScreenData(id), resolver: useTransactionResolver() };
}

function mount(accountId = 'a1') {
  return renderHook(useAccountPage, { wrapper, initialProps: { id: accountId } });
}

const rowIds = (rows: { transaction_id: string }[]) => rows.map((row) => row.transaction_id);

async function loadOlderPage(result: ReturnType<typeof mount>['result']) {
  await waitFor(() => expect(rowIds(result.current.page.transactions)).toEqual(['newest']));
  server.once('GET', '/transactions/feed', { body: { transactions: [OLDER], nextCursor: null } });
  act(() => result.current.page.loadMore());
  await waitFor(() => expect(rowIds(result.current.page.transactions)).toEqual(['newest', 'older']));
  expect(result.current.page.hasMore).toBe(false);
}

// [A6] An older row loaded only by Load More resolves (tap → detail) and a re-file updates it in
// place on the account page. Fail-on-revert: drop accountFeedKey from readTransactionCopies →
// findTx is undefined and applyCategory bails; drop it from patchTransactionsCache → the row keeps
// category null.
it('[A6] an older Load More row resolves, and a re-file updates it in place', async () => {
  const { result } = mount();
  await loadOlderPage(result);
  await waitFor(() => expect(result.current.resolver.findTx('older')).toBeDefined());

  act(() => result.current.app.setSheet({ mode: 'confirm', txId: 'older', categoryId: 'groceries' }));
  await act(async () => { await result.current.app.applyCategory('one'); });

  expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/older', body: { category: 'groceries' } });
  expect(result.current.page.transactions.find((row) => row.transaction_id === 'older')?.category).toBe('groceries');
  expect(result.current.resolver.findTx('older')?.category).toBe('groceries');
});

// [A7] Deleting that older row drops it from the account page; a failed delete puts it back on
// its own page. Fail-on-revert: drop accountFeedKey from patchTransactionsCache → it stays; from
// removeFromAllCopies' snapshot prefixes → the failed delete never restores it.
it('[A7] deleting an older Load More row removes it; a failed delete restores it', async () => {
  const { result } = mount();
  await loadOlderPage(result);

  server.once('DELETE', '/transactions/older', { status: 500 });
  await act(async () => { await result.current.app.deleteTransaction('older'); });
  expect(rowIds(result.current.page.transactions)).toEqual(['newest', 'older']);

  await act(async () => { await result.current.app.deleteTransaction('older'); });
  expect(rowIds(result.current.page.transactions)).toEqual(['newest']);
});

// [A8] Each account pages its own history: opening another account asks for ITS newest page (no
// cursor) and doesn't show the first account's loaded pages. Fail-on-revert: drop the account id
// from the query key → the second account reuses the first's cache and sends no request.
it('[A8] switching accounts reads the other account\'s own newest page', async () => {
  const { result, rerender } = mount('a1');
  await loadOlderPage(result);

  server.once('GET', '/transactions/feed', { body: { transactions: [colesTxn({ transaction_id: 'other', account_id: 'a2' })], nextCursor: null } });
  rerender({ id: 'a2' });
  await waitFor(() => expect(rowIds(result.current.page.transactions)).toEqual(['other']));
  const a2Reads = server.sentUnder('GET', '/transactions/feed').filter((request) => request.path.includes('account=a2'));
  expect(a2Reads.map((request) => request.path)).toEqual(['/transactions/feed?account=a2']);
});
