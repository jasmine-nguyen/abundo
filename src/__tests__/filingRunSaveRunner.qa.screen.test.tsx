// WHIT-647 (QA) — the failure half of the filing runs on the save runner. A 409 (clash) or a 502
// that lands after sign-out must come back as a plain failure: no clash sheet, no refresh, and the
// one-run-at-a-time lock released.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { FilingResult, FilingTarget } from '../context';
import { useFilingRun } from '../filingRun';
import { runOptimisticSave, type SaveSteps } from '../optimisticSave';
import type { UncategorizedMerchantGroup } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper } from './support/renderWithApp';

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const FAILED = { status: 'failed', background: false };

function mountHook(isSameSession: () => boolean) {
  const runSave = <R, T>(steps: SaveSteps<R, T>) => runOptimisticSave(isSameSession, steps);
  return renderHook(() => useFilingRun({
    sessionEpoch: { current: 0 }, runSave, prependMintedRule: jest.fn(), sheetOpen: true,
  })).result;
}

beforeEach(() => { queryClient.clear(); resetAuth(); });
afterEach(() => { queryClient.clear(); });

// [A1] (P0) The runner's session verdict beats the clash mapping for both preview and file now.
it('[A1] turns a shop clash into a plain failure when the runner says signed out', async () => {
  const r = mountHook(() => false);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  server.fail(APPLY_RULES, 409);

  let preview: FilingResult | null = null;
  let now: FilingResult | null = null;
  await act(async () => { preview = await r.current.previewFiling(SHOP); });
  await act(async () => { now = await r.current.fileCharges(SHOP, { now: true }); });

  expect(preview).toEqual(FAILED);
  expect(now).toEqual(FAILED);
  expect(spy).not.toHaveBeenCalled();
});

// [A2] (P0) A failing "file now" while signed out refreshes nothing and still frees the lock.
it('[A2] frees the lock after a failed file now the runner dropped, then refreshes on a live failure', async () => {
  let sameSession = false;
  const r = mountHook(() => sameSession);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  server.fail(APPLY_RULES, 502);

  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(spy).not.toHaveBeenCalled();

  sameSession = true;
  let again: FilingResult | null = null;
  await act(async () => { again = await r.current.fileCharges(SHOP, { now: true }); });
  expect(again).toEqual(FAILED);
  expect(server.sent('POST', APPLY_RULES)).toHaveLength(2);
  expect(spy).toHaveBeenCalled();
});

// [A3] (P0) Through the real provider: a clash that lands after sign-out shows no clash and
// refreshes nothing, for preview and file now.
it('[A3] drops a preview clash and a file-now clash that land after sign-out', async () => {
  server.once('POST', APPLY_RULES, { status: 409 });
  server.once('POST', APPLY_RULES, { status: 409 });
  const pending = server.hold(APPLY_RULES);   // the preview and the commit both stay in flight
  const r = renderHook(() => useAppContext(), {
    wrapper: appProviderWrapper,
  }).result;

  let previewing!: Promise<FilingResult>;
  let filing!: Promise<FilingResult>;
  act(() => { previewing = r.current.previewFiling(SHOP); });
  act(() => { filing = r.current.fileCharges(SHOP, { now: true }); });
  act(() => { setAuthStatus('anon'); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  let previewResult: FilingResult | null = null;
  let fileResult: FilingResult | null = null;
  await act(async () => {
    pending.release();                        // both then fail with a 409 clash
    previewResult = await previewing;
    fileResult = await filing;
  });

  expect(previewResult).toEqual(FAILED);
  expect(fileResult).toEqual(FAILED);
  expect(spy).not.toHaveBeenCalled();
});
