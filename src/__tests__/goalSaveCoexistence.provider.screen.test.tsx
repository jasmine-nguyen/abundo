// WHIT-197 GAP (cross-composite read-your-write) — the loanFactsWrite.provider suite asserts
// saveLoanFacts touches the cache via getQueryData, but NOT that a MOUNTED Goal composite
// observer reflects it. Here the real useGoalScreenData observes the singleton queryClient
// (the same client saveLoanFacts writes into) while the real AppProvider drives saveLoanFacts.
// What this LOCKS: the optimistic setQueryData(['loanFacts'], next) propagates the saved
// facts to the mounted composite observer — reverting that setQueryData leaves the observer
// stale → red (verified). It does NOT lock the follow-up invalidate: fetchLoanFacts is
// mocked to also return the saved facts, so the observer stays on FACTS whether or not the
// invalidate-refetch runs (that just avoids a timing-dependent flap back to the server value).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import { useGoalScreenData } from '../queries';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const EMPTY = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
const FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

// Provider order mirrors app/_layout.tsx: QueryClientProvider (singleton) OUTSIDE AppProvider,
// so saveLoanFacts' setQueryData on the singleton is seen by the composite's observer.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}><AppProvider>{children}</AppProvider></QueryClientProvider>
);

beforeEach(() => {
  queryClient.clear();
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.fetchLoanFacts.mockResolvedValue(EMPTY); // starts unset
  mockApi.listEnrichments.mockResolvedValue([]);
});
afterEach(() => { queryClient.clear(); });

it('a saveLoanFacts propagates to a mounted Goal composite observer (read-your-write)', async () => {
  mockApi.setLoanFacts.mockResolvedValue(FACTS);
  const { result } = renderHook(() => ({ ctx: useAppContext(), goal: useGoalScreenData() }), { wrapper });

  // Composite starts on the unset facts (equity unknowable).
  await waitFor(() => expect(result.current.goal.loanFacts).toEqual(EMPTY));

  // Keep the server read consistent with the save, so the follow-up invalidate-refetch
  // (if it runs) reconciles to the same FACTS rather than flapping the observer back to
  // EMPTY — the assertion below is on the optimistic setQueryData propagation.
  mockApi.fetchLoanFacts.mockResolvedValue(FACTS);
  await act(async () => { await result.current.ctx.saveLoanFacts(FACTS); });

  // The mounted Goal composite sees the saved facts without a manual reload.
  await waitFor(() => expect(result.current.goal.loanFacts).toEqual(FACTS));
  expect(result.current.goal.loanFacts.homeValue).toBe(770000); // equity inputs now consistent
});
