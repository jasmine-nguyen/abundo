// WHIT-162 — AppProvider must auto-reload when auth flips to 'authed'. With the
// static secret retired, the mount reads throw "Not signed in" pre-login and never
// re-run on their own (AppProvider mounts ABOVE the auth gate). This locks the fix
// that re-fires every read once the user signs in (or unlocks), so the app
// populates instead of stranding the "couldn't load" banner. Real AppProvider;
// ../api and ../auth mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

// Control the auth status + its subscribe listener.
let mockAuthStatus: 'loading' | 'authed' | 'anon' = 'anon';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (listener: () => void) => {
    mockAuthListeners.add(listener);
    return () => mockAuthListeners.delete(listener);
  },
}));

jest.mock('../api');
import * as api from '../api';
import { AppProvider, useAppContext } from '../context';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

function fireAuth(next: 'loading' | 'authed' | 'anon') {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

beforeEach(() => {
  mockAuthStatus = 'anon';
  mockAuthListeners.clear();
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

it('re-fires every mount read when auth transitions to authed (post-login recovery)', async () => {
  renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());

  // Clear the mount reads; the auth transition must re-fire them all.
  mockApi.fetchTransactions.mockClear();
  mockApi.fetchCategories.mockClear();
  mockApi.fetchPayCycle.mockClear();
  mockApi.fetchLoanFacts.mockClear();
  mockApi.fetchRepayment.mockClear();
  mockApi.fetchHomeLoan.mockClear();
  mockApi.listEnrichments.mockClear();
  mockApi.fetchBudgets.mockClear();
  mockApi.fetchBreakdown.mockClear();

  await act(async () => { fireAuth('authed'); });

  expect(mockApi.fetchTransactions).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchCategories).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchPayCycle).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchLoanFacts).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchRepayment).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchHomeLoan).toHaveBeenCalledTimes(1);
  expect(mockApi.listEnrichments).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchBudgets).toHaveBeenCalledTimes(1);
  // WHIT-189: breakdown is NOT part of the auth-flip reload — the Insights query owns it.
  expect(mockApi.fetchBreakdown).not.toHaveBeenCalled();
});

it('does NOT reload on a transition to anon (only authed triggers the reload)', async () => {
  renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  mockApi.fetchTransactions.mockClear();

  await act(async () => { fireAuth('anon'); });

  expect(mockApi.fetchTransactions).not.toHaveBeenCalled();
});
