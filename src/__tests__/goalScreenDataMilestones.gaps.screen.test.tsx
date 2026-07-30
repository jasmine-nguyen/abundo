// WHIT-367 GAPS (composite hook) — the milestones query is SECONDARY: deliberately kept OUT of
// useGoalScreenData's combined isLoading/isError (src/queries.ts:912) so a milestones read hiccup
// degrades to the built-in default plan instead of blanking/erroring the balance hero. This locks:
//   (1) a milestones REJECT leaves isError/isLoading untouched and milestones falls back to [];
//   (2) that [] fallback keeps a STABLE reference across renders (the frozen EMPTY_MILESTONES,
//       WHIT-244 identity trap) — a `?? []` regression would allocate a fresh array each render;
//   (3) a real saved list flows through the composite unchanged.
// Real QueryClientProvider drives the hook; ../api + ../auth mocked (mirrors goalScreenData.edges).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => { mockAuthListeners.add(l); return () => mockAuthListeners.delete(l); },
}));

const mockFetchHomeLoan = jest.fn<() => Promise<unknown>>();
const mockFetchRepayment = jest.fn<() => Promise<unknown>>();
const mockFetchLoanFacts = jest.fn<() => Promise<unknown>>();
const mockFetchMilestones = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchHomeLoan: () => mockFetchHomeLoan(),
  fetchRepayment: () => mockFetchRepayment(),
  fetchLoanFacts: () => mockFetchLoanFacts(),
  fetchMilestones: () => mockFetchMilestones(),
}));

import { useGoalScreenData } from '../queries';

const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
const SAVED_PLAN = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchHomeLoan.mockReset().mockResolvedValue(HOME_LOAN);
  mockFetchRepayment.mockReset().mockResolvedValue(REPAYMENT);
  mockFetchLoanFacts.mockReset().mockResolvedValue(READY_FACTS);
  mockFetchMilestones.mockReset().mockResolvedValue([]);
});

it('a milestones read FAILURE does not flip isError/isLoading and falls back to []', async () => {
  mockFetchMilestones.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });

  // The three primary reads all succeed; the milestones failure must NOT surface in the aggregate.
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  await waitFor(() => expect(mockFetchMilestones).toHaveBeenCalled());
  expect(result.current.isError).toBe(false);          // milestones is OUT of the combine
  expect(result.current.isLoading).toBe(false);
  expect(result.current.homeLoanError).toBe(false);
  expect(result.current.milestones).toEqual([]);       // degrades to the empty (→ default plan) list
});

it('the empty-milestones fallback keeps a STABLE reference across renders (frozen EMPTY_MILESTONES)', async () => {
  // Never resolves → the query stays cold → milestones is the `?? EMPTY_MILESTONES` fallback the
  // whole time. A `?? []` regression would hand back a fresh array per render (new reference).
  mockFetchMilestones.mockReset().mockReturnValue(new Promise(() => {}));
  const { result, rerender } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false)); // primaries done; milestones still cold
  const first = result.current.milestones;
  expect(first).toEqual([]);
  rerender({});
  expect(result.current.milestones).toBe(first);       // same reference — stable identity
});

it('a real saved milestone list flows through the composite unchanged', async () => {
  mockFetchMilestones.mockReset().mockResolvedValue(SAVED_PLAN);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.milestones).toHaveLength(2));
  expect(result.current.milestones).toEqual(SAVED_PLAN);
  expect(result.current.isError).toBe(false);
});
