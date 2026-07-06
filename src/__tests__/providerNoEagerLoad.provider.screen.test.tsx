// WHIT-192 — the teardown's core guarantee: AppProvider no longer eager-loads server data
// on mount (the eager store is gone; every screen reads the auth-gated query layer on
// demand). Locks it: mounting the provider fires ZERO server reads and populates no
// server-data cache itself. Fail-on-revert: re-add any eager mount fetch (or the auth-reload
// effect) and an assertion here breaks. The per-query "not fetched before login, fires on
// auth flip" behaviour that this used to cover on the store now lives in the *Query tests
// (transactionsQuery / budgetsQuery / settingsQuery / goalScreenData / rulesScreenData).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
// Pin 'authed' so a (hypothetical, reverted) auth-reload effect would fire if it still
// existed — making this a real fail-on-revert guard, not one masked by a signed-out gate.
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('does not eager-fetch any server data on mount (the query layer loads on demand)', () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });

  // The provider mounted (its actions are live)…
  expect(result.current.saveLoanFacts).toBeDefined();

  // …but not one server read fired — there's no eager store to fill.
  expect(mockApi.fetchTransactions).not.toHaveBeenCalled();
  expect(mockApi.fetchCategories).not.toHaveBeenCalled();
  expect(mockApi.fetchBudgets).not.toHaveBeenCalled();
  expect(mockApi.fetchPayCycle).not.toHaveBeenCalled();
  expect(mockApi.fetchBreakdown).not.toHaveBeenCalled();
  expect(mockApi.fetchHomeLoan).not.toHaveBeenCalled();
  expect(mockApi.fetchLoanFacts).not.toHaveBeenCalled();
  expect(mockApi.fetchRepayment).not.toHaveBeenCalled();
  expect(mockApi.listEnrichments).not.toHaveBeenCalled();

  // …and the provider populated no server-data cache of its own.
  expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  expect(queryClient.getQueryData(['categories'])).toBeUndefined();
});
