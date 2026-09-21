// WHIT-517 — REGRESSION gaps: the applyRulesToUncategorized signature grew a second `rule` arg and
// now throws an ApiError (not a plain Error). The existing "Apply my rules" callers
// (previewRuleApplication / applyRulesToHistory) pass NO rule and must be byte-identical in
// behaviour. The implementer's fileByShop.provider tests only cover the file-by-shop paths; these
// pin the untouched callers:
//   - [A30] applyRulesToHistory still calls the api with NO inline rule (a plain sweep)
//   - [A31] previewRuleApplication still calls the api with NO inline rule
//   - [A32] a 409 from applyRulesToHistory returns a BARE null (no clash leak) AND still refreshes
//   - [A33] a 409 from previewRuleApplication returns null (a preview reconciles nothing)
//   - [A34] an in-flight applyRulesToHistory turns away a fileByShop (the shared latch, both ways)
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesResult } from '../context';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: () => () => {},
}));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: false, rulesConsidered: 2, unfiled: 3, matched: 1, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
  filed: [{ id: 't1', category: 'groceries' }], vanished: [], failed: [], remaining: 0,
  ...over,
});

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: null, lastDate: null, alsoCatches: [],
};

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}
function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); mockStatus = 'authed'; });
afterEach(() => { queryClient.clear(); });

// [A30] "Apply my rules" must stay a plain sweep on the wire — no inline rule. Fail-on-revert: pass
// a rule through applyRulesToHistory and the exact-args match reddens.
it('[A30] applyRulesToHistory calls the api with dryRun false and NO inline rule', async () => {
  seedTransactionsCache(queryClient, []);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());
  const result = mount();
  await act(async () => { await result.current.applyRulesToHistory(); });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(false);
});

// [A31] The preview must also stay a plain dry-run — no inline rule.
it('[A31] previewRuleApplication calls the api with dryRun true and NO inline rule', async () => {
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true }));
  const result = mount();
  await act(async () => { await result.current.previewRuleApplication(); });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(true);
});

// [A32] The api now throws ApiError(409) on a clash. "Apply my rules" does NOT distinguish it — it
// returns a bare null (its return type has no `clash`) and still refreshes (unknown outcome).
// Fail-on-revert: if applyRulesToHistory ever grew a clash branch, the null-equality reddens.
it('[A32] a 409 from applyRulesToHistory returns bare null and still refreshes', async () => {
  seedTransactionsCache(queryClient, []);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let out: ApplyRulesResult | null | undefined;
  await act(async () => { out = await result.current.applyRulesToHistory(); });
  expect(out).toBeNull();
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A33] The preview swallows every error to null (it reconciles nothing) — including the new
// ApiError. Fail-on-revert: if the catch narrowed to non-ApiError, this throw would escape.
it('[A33] a 409 from previewRuleApplication returns null and refreshes nothing', async () => {
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let out: ApplyRulesResult | null | undefined;
  await act(async () => { out = await result.current.previewRuleApplication(); });
  expect(out).toBeNull();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// [A34] The shared latch, the OTHER direction from the implementer's test: an in-flight
// applyRulesToHistory must turn away a fileByShop (they share applyRulesInFlight). Fail-on-revert:
// give fileByShop its own latch and the second api call fires.
it('[A34] an in-flight applyRulesToHistory turns away a fileByShop', async () => {
  seedTransactionsCache(queryClient, []);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();
  let blocked: { ok: boolean } | undefined;
  await act(async () => {
    const first = result.current.applyRulesToHistory();   // holds the latch
    blocked = await result.current.fileByShop(GROUP, 'groceries');  // must be turned away
    pending.resolve(report());
    await first;
  });
  expect(blocked).toEqual({ ok: false, clash: null });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(1);
});
