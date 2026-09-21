// WHIT-552 — the useUncategorizedMerchants hook itself, against a REAL QueryClient (../api +
// ../auth mocked). Locks the hook's gate contract the Transactions screen depends on:
//   [M1] auth-gated AND backlog-gated: no whole-history walk while signed out.
//   [M2] authed + enabled=false (a caught-up user, count 0) → the walk does NOT fire. The WHIT-552
//        win: sparing caught-up users the heavy call. Fail-on-revert: drop the `&& enabled` gate
//        (back to auth-only) and the walk fires at count 0 → this fails.
//   [M3] authed + enabled=true (backlog) → it fetches and surfaces the grouped shops.
//   [M4] authed + default arg (the "File by shop" sheet path, no param) → it fetches. Fail-on-revert:
//        make the param required / non-defaulting and the sheet stops fetching → this fails.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { UncategorizedMerchants } from '../api';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchUncategorizedMerchants = jest.fn<() => Promise<UncategorizedMerchants>>();
jest.mock('../api', () => ({ fetchUncategorizedMerchants: () => mockFetchUncategorizedMerchants() }));

import { useUncategorizedMerchants } from '../queries';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const payload: UncategorizedMerchants = {
  unfiled: 3,
  groups: [{ merchant: 'Woolworths', rulePattern: 'WOOLWORTHS', groupedBy: 'merchant', count: 3,
    samples: ['WOOLWORTHS 123'], firstDate: '2026-07-01', lastDate: '2026-07-10', alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
};

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchUncategorizedMerchants.mockReset().mockResolvedValue(payload);
});

// [M1] auth still required — the backlog gate is additive, not a replacement.
it('does NOT fetch while signed out, even with enabled=true', () => {
  mockAuthStatus = 'anon';
  const { result } = renderHook(() => useUncategorizedMerchants(true), { wrapper: wrapper(makeClient()) });
  expect(mockFetchUncategorizedMerchants).not.toHaveBeenCalled();
  expect(result.current.merchants).toBeUndefined();
});

// [M2] the core WHIT-552 gate: authed but no backlog (count 0) → no heavy walk. Fail-on-revert:
// revert useUncategorizedMerchants to `useUncategorizedMerchantsQuery(useIsAuthed())` and this fails.
it('does NOT fetch when authed but the backlog is empty (enabled=false)', () => {
  const { result } = renderHook(() => useUncategorizedMerchants(false), { wrapper: wrapper(makeClient()) });
  expect(mockFetchUncategorizedMerchants).not.toHaveBeenCalled();
  expect(result.current.merchants).toBeUndefined();
});

// [M3] authed + backlog → the walk fires and the grouped shops come through.
it('fetches when authed and the backlog is non-empty (enabled=true)', async () => {
  const { result } = renderHook(() => useUncategorizedMerchants(true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.merchants).toEqual(payload));
  expect(mockFetchUncategorizedMerchants).toHaveBeenCalledTimes(1);
});

// [M4] the sheet path: called with no arg, the gate defaults to on so the "File by shop" sheet
// keeps its auth-only fetch. Fail-on-revert: make `enabled` required and the sheet stops fetching.
it('fetches with the default arg (the File-by-shop sheet path)', async () => {
  const { result } = renderHook(() => useUncategorizedMerchants(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.merchants).toEqual(payload));
  expect(mockFetchUncategorizedMerchants).toHaveBeenCalledTimes(1);
});
