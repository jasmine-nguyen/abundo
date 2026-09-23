// A complete, idle useTransactionsScreenData() value for screen tests that mock the hook. One
// builder so a new field on the hook (WHIT-576's `search`) is defaulted in ONE place, not in every
// suite's private copy. Each suite overrides only what it exercises.
import { jest } from '@jest/globals';

export const idleSearch = {
  active: false, results: [] as unknown[], answered: false, truncated: false, isError: false, retry: () => {},
};

export function transactionsScreenData(over: Record<string, unknown> = {}) {
  return {
    transactions: [] as unknown[],
    category: (_id: string | null): unknown => undefined,
    balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()), refreshLiveBalances: jest.fn(() => Promise.resolve()),
    hasMore: false, loadMore: jest.fn(), isLoadingMore: false,
    search: idleSearch,
    ...over,
  };
}
