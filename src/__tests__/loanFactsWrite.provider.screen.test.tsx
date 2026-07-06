// WHIT-191a — saveLoanFacts double-writes the ['loanFacts'] query cache + invalidates
// ONLY that key (home-loan balance + repayment don't depend on loan facts server-side),
// keeps the old store updated for the unmigrated readers (milestone / Insights aiGoalSignal
// / loan form), and rolls the old store back on failure. Drives the REAL saveLoanFacts via
// AppProvider + the singleton queryClient.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

beforeEach(() => {
  queryClient.clear();
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
});
afterEach(() => {
  queryClient.clear();
});

async function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loanFacts).toBeTruthy());
  return result;
}

it('saveLoanFacts double-writes the cache + invalidates ONLY loanFacts, and updates the old store', async () => {
  mockApi.setLoanFacts.mockResolvedValue(FACTS);
  const result = await mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });

  expect(ok).toBe(true);
  expect(result.current.loanFacts).toEqual(FACTS); // old store (milestone / insights / loan form)
  expect(queryClient.getQueryData(['loanFacts'])).toEqual(FACTS); // query cache double-write
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('loanFacts');
  expect(keys).not.toContain('homeLoan'); // balance doesn't depend on facts
  expect(keys).not.toContain('repayment');
  invalidateSpy.mockRestore();
});

it('rolls the old store back on a save failure and leaves the cache untouched', async () => {
  mockApi.setLoanFacts.mockRejectedValue(new Error('boom'));
  queryClient.setQueryData(['loanFacts'], { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  const result = await mount();
  const before = result.current.loanFacts;

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });

  expect(ok).toBe(false);
  expect(result.current.loanFacts).toEqual(before); // reverted (nothing saved)
  // cache untouched (the write only touches it AFTER a successful save)
  expect((queryClient.getQueryData(['loanFacts']) as typeof FACTS).original).toBeNull();
});
