// WHIT-204 GAP (keep-last-good) — the "must NOT stick" edges of keepLastGoodBalance that the
// existing net leaves open. goalScreenData.edges locks real→NULL HOLD; goalScreenData.screen
// locks first-ever-null → null. Missing: (1) a held null is REPLACED by a later real balance
// (the guard must not get stuck on the last-good forever); (2) a genuine $0 balance (loan paid
// off) is NOT held — the guard keys on `== null`, not falsiness, so 0 flows straight through.
// Fail-on-revert: removing structuralSharing breaks (1)'s hold step; changing `== null` to a
// falsy check (`!next?.balance`) makes (2) hold the old 596k and fail.
// ../api + ../auth mocked; real QueryClientProvider drives the hook (mirrors goalScreenData.edges).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

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
const NULL_HOME_LOAN = { balance: null, as_of: null, currency: null };
const HOME_LOAN_2 = { balance: 480000, as_of: '2026-08-01T00:00:00.000Z', currency: 'AUD' };
const ZERO_HOME_LOAN = { balance: 0, as_of: '2026-09-01T00:00:00.000Z', currency: 'AUD' }; // loan paid off
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const REPAYMENT_2 = { amount: 1600, date: '2026-08-01', principal: 1300, interest: 300 };
const REPAYMENT_3 = { amount: 1700, date: '2026-09-01', principal: 1350, interest: 350 };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchHomeLoan.mockReset().mockResolvedValue(HOME_LOAN);
  mockFetchRepayment.mockReset().mockResolvedValue(REPAYMENT);
  mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
});

it('a held null is later OVERWRITTEN by a real balance — keep-last-good does NOT stick', async () => {
  // Round 1: real 596k. Round 2 (refetch): null → held at 596k. Round 3 (refetch): a NEW real
  // 480k → must take effect. Sequence each round on the REPAYMENT read (which changes every
  // round) so the balance assertion fires only after that round's home-loan result is applied.
  mockFetchHomeLoan.mockReset()
    .mockResolvedValueOnce(HOME_LOAN).mockResolvedValueOnce(NULL_HOME_LOAN).mockResolvedValue(HOME_LOAN_2);
  mockFetchRepayment.mockReset()
    .mockResolvedValueOnce(REPAYMENT).mockResolvedValueOnce(REPAYMENT_2).mockResolvedValue(REPAYMENT_3);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  // Round 2: the null — held.
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600));
  expect(result.current.homeLoan.balance).toBe(596642.43); // last-good survives the null

  // Round 3: the new real balance — must replace the held value (not stuck).
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1700));
  expect(result.current.homeLoan.balance).toBe(480000);                    // updated
  expect(result.current.homeLoan.asOf).toBe('2026-08-01T00:00:00.000Z');   // and its timestamp
  expect(result.current.homeLoanError).toBe(false);
});

it('a genuine $0 balance (loan paid off) is NOT held — the guard keys on == null, not falsiness', async () => {
  mockFetchHomeLoan.mockReset().mockResolvedValueOnce(HOME_LOAN).mockResolvedValue(ZERO_HOME_LOAN);
  mockFetchRepayment.mockReset().mockResolvedValueOnce(REPAYMENT).mockResolvedValue(REPAYMENT_2);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600)); // 2nd round applied
  expect(result.current.homeLoan.balance).toBe(0);                         // 0 flows through — NOT held at 596k
  expect(result.current.homeLoan.asOf).toBe('2026-09-01T00:00:00.000Z');
  expect(result.current.homeLoanError).toBe(false);
});
