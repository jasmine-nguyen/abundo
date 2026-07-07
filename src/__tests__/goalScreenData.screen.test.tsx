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
  expect(result.current.repaymentError).toBe(false);
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
  // WHIT-121: a FIRST-LOAD repayment failure (nothing cached) sets the read's OWN error —
  // this drives the Goal card's error+Retry instead of the "No repayment" empty state.
  expect(result.current.repaymentError).toBe(true);
});

it('WHIT-121: a cached EMPTY repayment survives a failed refetch — no false error (firstLoadError)', async () => {
  // repaymentError is firstLoadError, NOT bare .isError: a repayment that once loaded EMPTY
  // (a user who genuinely has none), then hit a failed background refetch, keeps its cached
  // empty value → the honest render is the empty state, not "couldn't load". Only a
  // never-loaded read (nothing cached) flags an error.
  const EMPTY = { amount: null, date: null, principal: null, interest: null };
  const HOME_LOAN_2 = { balance: 480000, as_of: '2026-08-01T00:00:00.000Z', currency: 'AUD' };
  mockFetchHomeLoan.mockReset().mockResolvedValueOnce(HOME_LOAN).mockResolvedValue(HOME_LOAN_2);
  mockFetchRepayment.mockReset().mockResolvedValueOnce(EMPTY).mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(false)) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(result.current.repaymentError).toBe(false); // first load: an empty SUCCESS, not an error

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(480000)); // round 2 applied
  // The repayment refetch FAILED, but its cached empty value is retained → firstLoadError
  // stays false, so the card renders the honest empty state rather than a false error.
  expect(result.current.repaymentError).toBe(false);
  expect(result.current.repayment).toEqual(EMPTY);
});

it('WHIT-121: a first-load balance failure flags homeLoanError (nothing cached)', async () => {
  // The other half of firstLoadError for the balance: a never-loaded balance read that fails
  // DOES surface an error (the Goal + milestone heroes show "Couldn't load your balance.").
  mockFetchHomeLoan.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(false)) });
  await waitFor(() => expect(result.current.homeLoanError).toBe(true));
});

it('WHIT-121: a cached NULL balance survives a failed refetch — no false balance error (firstLoadError)', async () => {
  // homeLoanError is firstLoadError too: a balance that once resolved — even a legitimately
  // NULL "poller hasn't run yet" success — then hit a failed refetch keeps its cached value,
  // so the hero shows the waiting copy, NOT "couldn't load your balance". Only a never-loaded
  // read flags an error. Sequences the repayment read as the round marker (it changes each
  // round) so the balance assertion fires only after round 2's failed home-loan result lands.
  const NULL_BALANCE = { balance: null, as_of: null, currency: null };
  const REPAYMENT_2 = { amount: 1600, date: '2026-08-01', principal: 1300, interest: 300 };
  mockFetchHomeLoan.mockReset().mockResolvedValueOnce(NULL_BALANCE).mockRejectedValue(new Error('API error: 500'));
  mockFetchRepayment.mockReset().mockResolvedValueOnce(REPAYMENT).mockResolvedValue(REPAYMENT_2);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient(false)) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.homeLoanError).toBe(false); // first load: a NULL balance is a success
  expect(result.current.homeLoan.balance).toBeNull();

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600)); // round 2 applied
  // The balance refetch FAILED, but the cached null is retained → firstLoadError stays false,
  // so the hero renders the honest waiting copy rather than a false "couldn't load" error.
  expect(result.current.homeLoanError).toBe(false);
  expect(result.current.homeLoan.balance).toBeNull();
});
