// WHIT-197 GAPS (composite) — the branches the happy-path suite (goalScreenData.screen)
// doesn't lock: (1) a null balance on a LATER refetch overwrites a loaded balance
// (characterization of a REGRESSION vs the old store's keep-last-good — see QA critique
// #1); (2) a loan-facts read failure is aggregate-error-but-not-a-balance-error and the
// facts fall back to EMPTY_LOAN_FACTS; (3) refetchStale is stale-gated (no request storm).
// ../api + ../auth mocked; real QueryClientProvider drives the hook (mirrors goalScreenData.screen).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => { mockAuthListeners.add(l); return () => mockAuthListeners.delete(l); },
}));

const mockFetchHomeLoan = jest.fn<() => Promise<unknown>>();
const mockFetchRepayment = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchHomeLoan: () => mockFetchHomeLoan(),
  fetchRepayment: () => mockFetchRepayment(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
}));

import { useGoalScreenData } from '../queries';
import { EMPTY_LOAN_FACTS } from '../context';

const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const NULL_HOME_LOAN = { balance: null, as_of: null, currency: null };
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

// staleTime chosen per-test: 60s keeps data fresh (refetchStale no-op); 0 makes it stale.
function makeClient(staleTime: number) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchHomeLoan.mockReset().mockResolvedValue(HOME_LOAN);
  mockFetchRepayment.mockReset().mockResolvedValue(REPAYMENT);
  mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
});

it('a null balance on a LATER refetch DROPS the loaded balance (regression vs old keep-last-good)', async () => {
  // First read: a real balance. Second read (a focus/Retry refetch): the server's null
  // sentinel (poller row absent). selectHomeLoan maps raw.balance straight through, so the
  // loaded balance is lost — the old store (context.tsx:547) skipped this overwrite. This
  // test LOCKS the current behaviour; if the deferred keep-last-good fix lands, update it
  // (and the milestone hero flips back to the spinner rather than staying on the last balance).
  mockFetchHomeLoan.mockReset().mockResolvedValueOnce(HOME_LOAN).mockResolvedValue(NULL_HOME_LOAN);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(60_000)) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.homeLoan.balance).toBeNull());
  expect(result.current.homeLoanError).toBe(false); // a null response is a SUCCESS, not an error
});

it('a loan-facts read failure is an aggregate error but NOT a balance error, and facts fall back to empty', async () => {
  mockFetchLoanFacts.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(60_000)) });

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.homeLoanError).toBe(false);            // the balance read is fine
  expect(result.current.homeLoan.balance).toBe(596642.43);
  expect(result.current.loanFacts).toEqual(EMPTY_LOAN_FACTS);  // ?? EMPTY_LOAN_FACTS fallback
});

it('refetchStale is a no-op while every query is fresh (no request storm on focus)', async () => {
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(60_000)) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(mockFetchHomeLoan).toHaveBeenCalledTimes(1);
  expect(mockFetchRepayment).toHaveBeenCalledTimes(1);
  expect(mockFetchLoanFacts).toHaveBeenCalledTimes(1);

  await act(async () => { result.current.refetchStale(); });
  // fresh (staleTime 60s) → NOT stale → nothing refires.
  expect(mockFetchHomeLoan).toHaveBeenCalledTimes(1);
  expect(mockFetchRepayment).toHaveBeenCalledTimes(1);
  expect(mockFetchLoanFacts).toHaveBeenCalledTimes(1);
});

it('refetchStale refetches all three reads exactly once when they are stale', async () => {
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(0)) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(mockFetchHomeLoan).toHaveBeenCalledTimes(1));

  await act(async () => { result.current.refetchStale(); });
  // staleTime 0 → immediately stale → each refires once (and only once).
  await waitFor(() => expect(mockFetchHomeLoan).toHaveBeenCalledTimes(2));
  expect(mockFetchRepayment).toHaveBeenCalledTimes(2);
  expect(mockFetchLoanFacts).toHaveBeenCalledTimes(2);
});
