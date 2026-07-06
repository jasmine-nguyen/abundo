// WHIT-197 — the Goal tab + milestone screen's server reads (live balance + last
// repayment + loan facts) on the REAL query layer: not fetched before login, fires on
// the auth flip, self-heals a transient 5xx, treats a null balance as success (not an
// error), and keeps the home-loan error home-loan-SPECIFIC (a repayment failure is not
// a balance error). ../api + ../auth mocked; real QueryClientProvider drives the hook.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => {
    mockAuthListeners.add(l);
    return () => mockAuthListeners.delete(l);
  },
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockFetchHomeLoan = jest.fn<() => Promise<unknown>>();
const mockFetchRepayment = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchHomeLoan: () => mockFetchHomeLoan(),
  fetchRepayment: () => mockFetchRepayment(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
}));

import { useGoalScreenData } from '../queries';

const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

function makeClient(retry: boolean | number = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
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

it('assembles the balance (as_of→asOf), repayment, and loan facts from the three reads', async () => {
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.homeLoan).toEqual({ balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' });
  expect(result.current.repayment).toEqual(REPAYMENT);
  expect(result.current.loanFacts).toEqual(READY_FACTS);
  expect(result.current.isError).toBe(false);
  expect(result.current.homeLoanError).toBe(false);
});

it('does not fetch before login, then fires on the auth flip to authed', async () => {
  mockAuthStatus = 'anon';
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  expect(mockFetchHomeLoan).not.toHaveBeenCalled();
  expect(mockFetchRepayment).not.toHaveBeenCalled();
  expect(mockFetchLoanFacts).not.toHaveBeenCalled();

  await act(async () => { setAuth('authed'); });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(mockFetchHomeLoan).toHaveBeenCalled();
});

it('a transient 5xx on the balance read retries and self-heals', async () => {
  mockFetchHomeLoan.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue(HOME_LOAN);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(2)) });

  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(result.current.homeLoanError).toBe(false);
  expect(mockFetchHomeLoan).toHaveBeenCalledTimes(2);
});

it('treats a null balance as a normal success — not an error', async () => {
  mockFetchHomeLoan.mockReset().mockResolvedValue({ balance: null, as_of: null, currency: null });
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.homeLoan).toEqual({ balance: null, asOf: null });
  expect(result.current.homeLoanError).toBe(false);
  expect(result.current.isError).toBe(false);
});

it('keeps homeLoanError home-loan-specific: a repayment failure is not a balance error', async () => {
  mockFetchRepayment.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(false)) });

  await waitFor(() => expect(result.current.isError).toBe(true)); // aggregate reflects the repayment failure
  expect(result.current.homeLoanError).toBe(false); // ...but the balance read is fine
  expect(result.current.homeLoan.balance).toBe(596642.43);
});
