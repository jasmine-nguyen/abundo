// Provider test: the enrichments wiring in AppProvider (WHIT-52 Slice 2).
// Mounts the real provider with ../api fully mocked and exercises: load rules
// from the server (seed removal), optimistic create + reconcile + rollback, and
// optimistic delete + rollback. renderHook drives useAppContext directly.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';

jest.mock('../api');
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// The provider's mount effect calls FIVE fetchers — all must resolve or the async
// effect throws before any assertion. Tests override listEnrichments as needed.
beforeEach(() => {
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.listEnrichments.mockResolvedValue([]);
});

const SERVER_RULE = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' } as const;

it('loads rules from the server on mount and shows no fake seeds', async () => {
  mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(result.current.enrichmentsLoading).toBe(false));
  expect(result.current.rules).toEqual([
    { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' },
  ]);
  // The old WOOLWORTHS/AGL seed rules are gone.
  expect(result.current.rules.some((r) => r.pattern === 'WOOLWORTHS')).toBe(false);
});

it('surfaces a retryable error when the load fails', async () => {
  mockApi.listEnrichments.mockRejectedValue(new Error('boom'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(result.current.enrichmentsError).toBe('Could not load rules.'));
  expect(result.current.enrichmentsLoading).toBe(false);
  expect(result.current.rules).toEqual([]);
});

it('saveManualRule creates the rule and swaps the temp id for the server id', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.enrichmentsLoading).toBe(false));

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // Sent as typed (trimmed, not upper-cased); no field/operator (server defaults).
  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'spotify', categoryId: 'subs' });
  // Reconciled to the server id, but keeps isNew:true so the "NEW" badge survives.
  expect(result.current.rules[0]).toEqual({ id: 'e9', pattern: 'spotify', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' });
});

it('saveManualRule rolls back the optimistic rule when the create fails', async () => {
  mockApi.createEnrichment.mockRejectedValue(new Error('API error: 400'));
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.enrichmentsLoading).toBe(false));

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(result.current.rules).toEqual([]);
  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});

it('deleteRule removes the rule on success', async () => {
  mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
  mockApi.deleteEnrichment.mockResolvedValue({ id: 'e1' });
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(mockApi.deleteEnrichment).toHaveBeenCalledWith('e1');
  expect(result.current.rules).toEqual([]);
});

it('deleteRule restores the rule at its position when the delete fails', async () => {
  mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
  mockApi.deleteEnrichment.mockRejectedValue(new Error('boom'));
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(result.current.rules).toHaveLength(1);
  expect(result.current.rules[0].id).toBe('e1');
  expect(result.current.toast).toBe('Could not delete rule. Please try again.');
});
