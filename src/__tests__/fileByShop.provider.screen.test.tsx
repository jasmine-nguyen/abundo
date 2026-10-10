// WHIT-517 — the two context actions behind "File by shop": previewFileByShop and fileByShop.
//
// Both mint-and-file ONE shop in a single apply-rules call (an inline rule), so the properties that
// carry real risk are:
//   - the inline rule reaches the wire (value = the group's rulePattern, categoryId = the pick), or
//     nothing is minted and nothing filed;
//   - a 409 clash (an existing rule already files this shop elsewhere) is kept DISTINCT from any
//     other failure — {clash: ApiError} vs {clash: null} — and on a clash NOTHING is written and
//     NOTHING is refreshed (the server minted nothing);
//   - any OTHER failure still refreshes the caches (the write may have partly landed), like
//     applyRulesToHistory;
//   - a success patches the filed rows and refreshes the "file by shop" list (['uncategorizedMerchants'])
//     and the rules list (['rules']) so the filed shop leaves the list and the new rule appears;
//   - it shares the in-flight latch with applyRulesToHistory, so the two bulk actions can't overlap;
//   - a run settling after sign-out paints nothing.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { ApplyRulesResult, FilingResult, FilingTarget } from '../context';
import type { Transaction } from '../types';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { COLES_CREATED_RULE, filedReport } from './support/applyRulesReport';
import { colesTxn as txn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';
const SWEEP: FilingTarget = { kind: 'sweep' };

const report = (over: Partial<ApplyRulesResult> = {}) => filedReport({ createdRule: COLES_CREATED_RULE, ...over });

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};

function rowsIn(key: 'transactions'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

beforeEach(() => { queryClient.clear(); resetAuth(); });
afterEach(() => { queryClient.clear(); });

// --- fileByShop: the write ----------------------------------------------------

// The load-bearing wire property: the inline rule must be {value: rulePattern, categoryId}. Fail-on-
// revert: drop the rule arg and the call goes out as a plain sweep, minting nothing.
it('sends the inline rule (value = the group pattern, category = the pick) with dryRun false', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report());

  const result = mount();
  await act(async () => { await result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true }); });

  expect(server.requests()).toContainEqual({
    method: 'POST', path: APPLY_RULES, body: { dryRun: false, rule: { value: 'coles', categoryId: 'groceries' } },
  });
});

it('patches the filed row and returns { ok, report } on success', async () => {
  seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
  server.seed(APPLY_RULES, report({ filed: [{ id: 't1', category: 'groceries' }] }));

  const result = mount();
  let outcome: FilingResult | null = null;
  await act(async () => { outcome = await result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true }); });

  expect(outcome).toEqual({ status: 'filed', report: expect.objectContaining({ filed: [{ id: 't1', category: 'groceries' }] }) });
  const byId = new Map(rowsIn('transactions').map((r) => [r.transaction_id, r.category]));
  expect(byId.get('t1')).toBe('groceries');
  expect(byId.get('untouched')).toBeNull();
});

// The WHIT-517 invalidations: the filed shop must leave the "file by shop" list, and the new rule
// must appear in the rules list. Fail-on-revert: drop either invalidateQueries and its key is gone.
it('invalidates the shop list and the rules list after a successful file', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report());

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true }); });

  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['uncategorizedMerchants', 'rules', 'uncategorizedCount']));
  spy.mockRestore();
});

// The clash: an existing rule already files this shop elsewhere. It must be DISTINCT from a generic
// failure (so the sheet shows its clash copy) AND write/refresh nothing (the server minted nothing).
// Fail-on-revert: collapse the 409 to a bare null and `clash` goes null; refresh on a clash and the
// invalidate spy fires.
it('returns { clash } and refreshes nothing on a 409 clash', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.fail(APPLY_RULES, 409);

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: FilingResult | null = null;
  await act(async () => { outcome = await result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true }); });

  expect(outcome).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
  expect(spy).not.toHaveBeenCalled();               // nothing was minted → nothing to refresh
  expect(rowsIn('transactions')[0].category).toBeNull();
  spy.mockRestore();
});

// Any OTHER failure is an UNKNOWN outcome (row-by-row writes, a late abort), so it still refreshes —
// but clash stays null so the sheet does NOT show the clash copy. Fail-on-revert: drop the refresh
// from the catch and the invalidate spy never fires.
it('returns { clash: null } and still refreshes on a non-clash failure', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.fail(APPLY_RULES, 502);

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: FilingResult | null = null;
  await act(async () => { outcome = await result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true }); });

  expect(outcome).toEqual({ status: 'failed', background: false });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// The shared latch: "Apply my rules" and "File by shop" must never run at once (two whole-history
// mint+file passes racing would resolve out of order). Fail-on-revert: give fileByShop its own latch
// and the second call fires a second api request.
it('shares the in-flight latch with applyRulesToHistory', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.once('POST', APPLY_RULES, { body: report() });
  const pending = server.hold(APPLY_RULES);

  const result = mount();
  await act(async () => {
    const first = result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true });   // holds the latch
    const blocked = await result.current.fileCharges(SWEEP, { now: true });     // must be turned away
    expect(blocked).toEqual({ status: 'failed', background: false });
    pending.release();
    await first;
  });

  expect(server.sent('POST', APPLY_RULES)).toHaveLength(1);
});

// --- previewFileByShop: the dry run -------------------------------------------

it('previews with dryRun true and the inline rule, writing nothing', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report({ dryRun: true, filed: [], createdRule: null }));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: FilingResult | null = null;
  await act(async () => { outcome = await result.current.previewFiling({ kind: 'shop', group: GROUP, categoryId: 'groceries' }); });

  expect(server.requests()).toContainEqual({
    method: 'POST', path: APPLY_RULES, body: { dryRun: true, rule: { value: 'coles', categoryId: 'groceries' } },
  });
  expect(outcome).toEqual({ status: 'filed', report: expect.anything() });
  expect(spy).not.toHaveBeenCalled();                        // a preview reconciles nothing
  expect(rowsIn('transactions')[0].category).toBeNull();     // ...and touches no row
  spy.mockRestore();
});

it('surfaces a 409 clash from the preview (distinct from a generic failure)', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.fail(APPLY_RULES, 409);

  const result = mount();
  let outcome: FilingResult | null = null;
  await act(async () => { outcome = await result.current.previewFiling({ kind: 'shop', group: GROUP, categoryId: 'groceries' }); });

  expect(outcome).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
});

// --- "Apply my rules" (the plain sweep) shares the same api call ---------------

// [A30] "Apply my rules" must stay a plain sweep on the wire — no inline rule. Fail-on-revert: pass
// a rule through applyRulesToHistory and the exact-args match reddens.
it('[A30] applyRulesToHistory calls the api with dryRun false and NO inline rule', async () => {
  seedTransactionsCache(queryClient, []);
  server.seed(APPLY_RULES, filedReport());
  const result = mount();
  await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });
  expect(server.requests()).toContainEqual({ method: 'POST', path: APPLY_RULES, body: { dryRun: false } });
});

// [A32] "Apply my rules" does NOT distinguish a 409 clash — it returns a plain failure and still
// refreshes (unknown outcome). Fail-on-revert: grow a clash branch and the equality reddens.
it('[A32] a 409 from applyRulesToHistory returns bare null and still refreshes', async () => {
  seedTransactionsCache(queryClient, []);
  server.fail(APPLY_RULES, 409);
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let out: FilingResult | undefined;
  await act(async () => { out = await result.current.fileCharges(SWEEP, { now: true }); });
  expect(out).toEqual({ status: 'failed', background: false });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// --- session safety -----------------------------------------------------------

// A file settling after sign-out must not paint the next session's caches. Fail-on-revert: drop the
// post-await epoch check and the signed-out session gets the old account's row filed.
it('bails without painting when a file settles after sign-out', async () => {
  server.once('POST', APPLY_RULES, { body: report({ filed: [{ id: 't1', category: 'groceries' }] }) });
  const pending = server.hold(APPLY_RULES);
  const result = mount();

  let outcome: FilingResult | null = null;
  await act(async () => {
    const inFlight = result.current.fileCharges({ kind: 'shop', group: GROUP, categoryId: 'groceries' }, { now: true });
    setAuthStatus('anon');
    seedTransactionsCache(queryClient, [txn()]);
    pending.release();
    outcome = await inFlight;
  });

  expect(outcome).toEqual({ status: 'failed', background: false });
  expect(rowsIn('transactions')[0].category).toBeNull();
});
