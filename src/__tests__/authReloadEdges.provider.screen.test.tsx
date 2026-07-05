// WHIT-162 — auto-reload edges the implementer's authReload suite doesn't cover:
//  (1) a repeated authed transition (authed → locked → authed, the Face ID resume
//      path) reloads on EACH authed edge, and a 'locked' edge does NOT reload;
//  (2) unmount unsubscribes the auth listener (no leak — a stale listener would
//      setState after teardown). Real AppProvider; ../api and ../auth mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

let mockAuthStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'anon';
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

function fireAuth(next: 'loading' | 'authed' | 'anon' | 'locked') {
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

it('reloads on each authed edge (authed → locked → authed); locked does not reload', async () => {
  renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  mockApi.fetchTransactions.mockClear();

  await act(async () => { fireAuth('authed'); });
  expect(mockApi.fetchTransactions).toHaveBeenCalledTimes(1); // first unlock/login

  await act(async () => { fireAuth('locked'); });
  expect(mockApi.fetchTransactions).toHaveBeenCalledTimes(1); // locked must NOT reload

  await act(async () => { fireAuth('authed'); });
  expect(mockApi.fetchTransactions).toHaveBeenCalledTimes(2); // resume unlock reloads again
});

it('unsubscribes the auth listener on unmount (no leak)', async () => {
  const { unmount } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  expect(mockAuthListeners.size).toBeGreaterThan(0);

  unmount();

  expect(mockAuthListeners.size).toBe(0);
});
