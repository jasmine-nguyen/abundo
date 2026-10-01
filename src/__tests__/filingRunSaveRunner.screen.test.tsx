// WHIT-647 — the filing preview and "file now" go through the shared save runner (runOptimisticSave)
// instead of checking the session stamp by hand. The provider's runSave is handed into useFilingRun;
// whatever that runner decides about the session is final. Here the runner says "signed out" while
// the hook's own session stamp never moves — so only a filing run that really uses the runner drops
// the result. The job path (startJob / polling) is out of scope and keeps its own checks.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useFilingRun, type FilingResult, type FilingTarget } from '../filingRun';
import { runOptimisticSave, type SaveSteps } from '../optimisticSave';
import type { ApplyRulesResult, UncategorizedMerchantGroup } from '../api';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';

const server = installFakeServer();

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: false, rulesConsidered: 1, unfiled: 1, matched: 1, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
  filed: [{ id: 't1', category: 'groceries' }], vanished: [], failed: [], remaining: 0, createdRule: null, ...over,
} as ApplyRulesResult);

const UNFILED = { transaction_id: 't1', description: 'COLES 1234', amount: -10, category: null } as unknown as Transaction;

beforeEach(() => { queryClient.clear(); resetAuth(); });
afterEach(() => { queryClient.clear(); });

it('drops the filing preview and "file now" when the save runner says the user signed out', async () => {
  let sameSession = false;
  const runSave = jest.fn(<R, T>(steps: SaveSteps<R, T>) => runOptimisticSave(() => sameSession, steps));
  const sessionEpoch = { current: 0 };
  seedTransactionsCache(queryClient, [UNFILED]);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  server.seed('/transactions/uncategorized/apply-rules', report());

  const { result } = renderHook(() => useFilingRun({
    sessionEpoch, runSave, prependMintedRule: jest.fn(), sheetOpen: true,
  } as Parameters<typeof useFilingRun>[0]));

  let preview: FilingResult | null = null;
  let now: FilingResult | null = null;
  await act(async () => { preview = await result.current.previewFiling(SHOP); });
  await act(async () => { now = await result.current.fileCharges(SHOP, { now: true }); });

  expect(preview).toEqual({ status: 'failed', background: false });
  expect(now).toEqual({ status: 'failed', background: false });
  expect(readTransactionsCache(queryClient)[0].category).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();

  // The one-run-at-a-time lock was released: once the runner says the session is live, "file now"
  // files and paints the row.
  sameSession = true;
  let again: FilingResult | null = null;
  await act(async () => { again = await result.current.fileCharges(SHOP, { now: true }); });
  expect(again).toEqual({ status: 'filed', report: report() });
  expect(readTransactionsCache(queryClient)[0].category).toBe('groceries');
});
