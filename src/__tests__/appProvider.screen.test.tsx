// Provider mutation tests (WHIT-90): drive the real AppProvider through its
// category/budget/transaction actions with ../api mocked. Covers applyCategory
// (one + all), saveBudget, saveCategory (create + edit), deleteCategory — success
// and failure/rollback — plus the toCategory mapper (categories load from a
// mocked non-empty fetch). renderHook drives useAppContext directly.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';

jest.mock('../api');
// WHIT-174: the load-error banner is now an AUTHED-only concern (a signed-out
// mount's reads throw "Not signed in" and must NOT raise it). These tests drive the
// provider as a signed-in user, so pin the auth status to 'authed'.
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const TXN = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
} as const;

beforeEach(() => {
  mockApi.fetchTransactions.mockResolvedValue([{ ...TXN }]);
  mockApi.fetchCategories.mockResolvedValue([{ ...CAT }]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
  // Batch category write (WHIT-70): default to "all updated", echoing the ids sent.
  mockApi.setTransactionCategories.mockImplementation(
    async (updates: { id: string; category: string }[]) =>
      ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});

async function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  // Wait until the mount effects settle: categories mapped (toCategory) + txns loaded.
  await waitFor(() => {
    expect(result.current.categories.some((c) => c.id === 'groceries')).toBe(true);
    expect(result.current.transactions.length).toBeGreaterThan(0);
  });
  return result;
}

// --- applyCategory -----------------------------------------------------------

it('applyCategory(one) files the transaction and persists it', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).toHaveBeenCalledWith('t1', 'groceries');
  expect(result.current.transactions[0].category).toBe('groceries');
  expect(result.current.sheet).toBeNull();
});

it('applyCategory(one) rolls the category back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(result.current.transactions[0].category).toBeNull();
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

it('applyCategory(all) files every same-merchant charge — and ONLY that merchant — then creates a rule', async () => {
  // t1/t2: same Coles merchant → both get filed. t3: a different merchant whose
  // description happens to contain the "COLES" token but whose merchant_name is
  // Woolworths → must be EXCLUDED by the same-merchant gate, proving the sweep
  // keys on merchant_name, not a loose description match.
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1' },
    { ...TXN, transaction_id: 't2' },
    { ...TXN, transaction_id: 't3', description: 'WOOLWORTHS NEAR COLES ST', merchant_name: 'Woolworths' },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(3));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // ONE batch call (WHIT-70), not N single PATCHes — carrying t1 + t2 only, NOT t3.
  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(1);
  expect(mockApi.setTransactionCategory).not.toHaveBeenCalled();
  expect(mockApi.setTransactionCategories.mock.calls[0][0].map((u) => u.id).sort()).toEqual(['t1', 't2']);
  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' });

  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');
  expect(byId.t2).toBe('groceries');
  expect(byId.t3).toBeNull();                                        // Woolworths untouched
  expect(result.current.rules).toHaveLength(1);
});

it('applyCategory(all) sweeps same-merchant charges tagged with a RAW bank category, not just null ones', async () => {
  // The "uncategorized" charges the user sees can carry a raw BankSync enum (e.g.
  // FOOD_AND_DRINK), NOT null. The sweep must catch those too — a plain
  // category==null check silently skipped them (the KKV bug). A charge already
  // filed under a real user category must NOT be swept (don't overwrite it).
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null },              // tapped origin (null)
    { ...TXN, transaction_id: 't2', category: 'FOOD_AND_DRINK' },  // raw enum, same merchant -> MUST sweep
    { ...TXN, transaction_id: 't3', category: 'groceries' },       // real user category -> must NOT touch
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(3));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // t1 (null) + t2 (raw enum) swept in ONE batch; t3 (already groceries) left alone.
  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(1);
  const swept = mockApi.setTransactionCategories.mock.calls[0][0].map((u) => u.id).sort();
  expect(swept).toEqual(['t1', 't2']);
  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t2).toBe('groceries');   // the FOOD_AND_DRINK charge is now filed
});

it('applyCategory(all) rolls back only the ids the batch reports as not saved', async () => {
  // Partial server success: the batch files t1 but reports t2 not_found. Only t2
  // reverts (to uncategorised); t1 stays filed. Rollback keys BY ID, not position.
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockResolvedValue({
    results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }],
  });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(2));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');   // saved -> stays
  expect(byId.t2).toBeNull();          // not_found -> reverted
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

it('applyCategory(all) rolls back ALL ids when the whole batch call rejects', async () => {
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockRejectedValue(new Error('network'));
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(2));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBeNull();
  expect(byId.t2).toBeNull();
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

it('applyCategory(all) refreshes budgets + breakdown when at least one charge saved', async () => {
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  // Partial: t1 saved, t2 not — still >=1 saved, so spend changed -> refresh MUST fire.
  mockApi.setTransactionCategories.mockResolvedValue({
    results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }],
  });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(2));
  mockApi.fetchBudgets.mockClear();
  mockApi.fetchBreakdown.mockClear();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.fetchBudgets).toHaveBeenCalled();
  expect(mockApi.fetchBreakdown).toHaveBeenCalled();
});

it('applyCategory(all) does NOT refresh budgets/breakdown when the whole batch fails', async () => {
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockRejectedValue(new Error('network'));
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(2));
  mockApi.fetchBudgets.mockClear();
  mockApi.fetchBreakdown.mockClear();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // All reverted -> nothing persisted -> spend unchanged -> no wasted refetch.
  expect(mockApi.fetchBudgets).not.toHaveBeenCalled();
  expect(mockApi.fetchBreakdown).not.toHaveBeenCalled();
});

it('applyCategory(all) does NOT call the batch when the sweep is empty', async () => {
  // Origin doesn't count to a budget -> excluded from sameMerchantIds -> empty set.
  // A real server 400s on {updates:[]}; the client must not send it at all (E1 fix).
  mockApi.fetchTransactions.mockResolvedValue([
    { ...TXN, transaction_id: 't1', category: null, counts_to_budget: false },
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(1));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
});

it('applyCategory(all) splits a >100 sweep into chunks of 100 (WHIT-70 chunking)', async () => {
  // 150 same-merchant uncategorised charges -> the sweep must send TWO batch calls
  // (100 + 50), not one oversized request the server would 400.
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  mockApi.fetchTransactions.mockResolvedValue(many);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(150));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(2);
  const sizes = mockApi.setTransactionCategories.mock.calls.map((c) => c[0].length).sort((a, b) => b - a);
  expect(sizes).toEqual([100, 50]);
  // Both chunks succeed (default echo mock) -> all 150 filed.
  expect(result.current.transactions.filter((t) => t.category === 'groceries')).toHaveLength(150);
});

it('applyCategory(all) reverts only the failed chunk when one of several rejects', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  mockApi.fetchTransactions.mockResolvedValue(many);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  // First chunk (100) succeeds; second chunk (50) rejects -> only those 50 revert.
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => {
    if (updates.length !== 100) throw new Error('chunk failed');
    return { results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) };
  });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(150));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t0).toBe('groceries');   // first chunk (t0..t99) saved
  expect(byId.t149).toBeNull();        // second chunk (t100..t149) rejected -> reverted
  expect(result.current.transactions.filter((t) => t.category === 'groceries')).toHaveLength(100);
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

// --- saveBudget --------------------------------------------------------------

it('saveBudget persists a target and returns true', async () => {
  mockApi.setBudget.mockResolvedValue({ id: 'groceries', target: 300 });
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });

  expect(ok).toBe(true);
  expect(mockApi.setBudget).toHaveBeenCalledWith('groceries', 300);
});

it('saveBudget rejects a non-positive target without calling the API', async () => {
  const result = await mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 0); });
  expect(ok).toBe(false);
  expect(mockApi.setBudget).not.toHaveBeenCalled();
});

it('saveBudget returns false + toasts on failure', async () => {
  mockApi.setBudget.mockRejectedValue(new Error('x'));
  const result = await mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save budget. Please try again.');
});

// --- saveCategory ------------------------------------------------------------

it('saveCategory creates a new category', async () => {
  mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00', recent: 0 });
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });

  expect(ok).toBe(true);
  expect(mockApi.createCategory).toHaveBeenCalledWith({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
  expect(result.current.categories.some((c) => c.id === 'gym')).toBe(true);
});

it('saveCategory edits an existing category in place', async () => {
  mockApi.updateCategory.mockResolvedValue({ id: 'groceries', name: 'Supermarket', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0 });
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }); });

  expect(ok).toBe(true);
  expect(mockApi.updateCategory).toHaveBeenCalledWith('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' });
  expect(result.current.categories.find((c) => c.id === 'groceries')?.name).toBe('Supermarket');
});

it('saveCategory returns false + toasts on failure', async () => {
  mockApi.createCategory.mockRejectedValue(new Error('x'));
  const result = await mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

// --- deleteCategory ----------------------------------------------------------

it('deleteCategory removes it (local cascade) and returns true', async () => {
  mockApi.deleteCategory.mockResolvedValue({ id: 'groceries' });
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteCategory('groceries'); });

  expect(ok).toBe(true);
  expect(mockApi.deleteCategory).toHaveBeenCalledWith('groceries');
  expect(result.current.categories.some((c) => c.id === 'groceries')).toBe(false);
});

it('deleteCategory returns false + toasts on failure', async () => {
  mockApi.deleteCategory.mockRejectedValue(new Error('x'));
  const result = await mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteCategory('groceries'); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
});

// --- refreshHomeLoan (WHIT-8) ------------------------------------------------

it('refreshHomeLoan overwrites the live balance on mount', async () => {
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' });
  const result = await mount();
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(result.current.homeLoan.asOf).toBe('2026-07-04T00:24:37.614Z');
});

it('refreshHomeLoan keeps the placeholder when the balance is null (unpolled)', async () => {
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  const result = await mount();
  // A null-balance response is a no-op: the seed placeholder (null) stands, no throw.
  expect(result.current.homeLoan.balance).toBeNull();
  expect(result.current.homeLoanError).toBe(false);
});

it('refreshHomeLoan flags an error when the fetch fails (not a permanent spinner)', async () => {
  mockApi.fetchHomeLoan.mockRejectedValue(new Error('network'));
  const result = await mount();
  await waitFor(() => expect(result.current.homeLoanError).toBe(true));
  expect(result.current.homeLoan.balance).toBeNull();
});

// --- loan facts (Loan facts card) --------------------------------------------

const FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

it('refreshLoanFacts loads saved facts on mount', async () => {
  mockApi.fetchLoanFacts.mockResolvedValue(FACTS);
  const result = await mount();
  await waitFor(() => expect(result.current.loanFacts.homeValue).toBe(770000));
  expect(result.current.loanFacts.original).toBe(600000);
});

it('saveLoanFacts persists + optimistically updates, returns true', async () => {
  mockApi.setLoanFacts.mockResolvedValue(FACTS);
  const result = await mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(true);
  expect(mockApi.setLoanFacts).toHaveBeenCalledWith(FACTS);
  expect(result.current.loanFacts.homeValue).toBe(770000);
});

it('saveLoanFacts rolls back + toasts on failure', async () => {
  mockApi.setLoanFacts.mockRejectedValue(new Error('x'));
  const result = await mount();  // mounts with all-null facts (beforeEach)
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(false);
  // Rolled back to the pre-save (unset) state; the user is told.
  expect(result.current.loanFacts.homeValue).toBeNull();
  expect(result.current.toast).toBe('Could not save loan details. Please try again.');
});

// --- WHIT-74: read/load-failure banner ---------------------------------------
// A failed mount fetch / pull-to-refresh READ must raise loadError (drives the
// global "couldn't load" banner) instead of silently leaving an empty app, keep the
// seeded categories as the offline fallback, and be clearable/retryable. Writes are
// unaffected — they keep their own toast+rollback and must NOT raise this banner.

it('a read failure on mount raises loadError but keeps the seeded categories', async () => {
  mockApi.fetchCategories.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loadError).toBe(true));
  // Fallback held: the full seed set (many categories, incl. seed-only 'coffee')
  // stands — NOT the single-item mock payload that a successful fetch would install.
  expect(result.current.categories.length).toBeGreaterThan(1);
  expect(result.current.categories.some((c) => c.id === 'coffee')).toBe(true);
});

it.each([
  ['fetchTransactions', () => mockApi.fetchTransactions.mockRejectedValue(new Error('x'))],
  ['fetchBudgets', () => mockApi.fetchBudgets.mockRejectedValue(new Error('x'))],
  ['fetchPayCycle', () => mockApi.fetchPayCycle.mockRejectedValue(new Error('x'))],
])('a failing %s on mount raises loadError', async (_name, reject) => {
  reject();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loadError).toBe(true));
});

it('retryLoad clears the banner and reloads once the network recovers', async () => {
  mockApi.fetchTransactions.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loadError).toBe(true));

  mockApi.fetchTransactions.mockResolvedValue([{ ...TXN }]);
  await act(async () => { result.current.retryLoad(); });

  await waitFor(() => expect(result.current.loadError).toBe(false));
  expect(result.current.transactions.length).toBeGreaterThan(0);
});

it('a retry that still fails keeps the banner up', async () => {
  mockApi.fetchTransactions.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loadError).toBe(true));

  // Still offline across the retry → the flag comes straight back.
  await act(async () => { result.current.retryLoad(); });
  await waitFor(() => expect(result.current.loadError).toBe(true));
});

it('a failed background refreshBudgets does NOT raise the banner (write re-syncs stay silent)', async () => {
  // The write paths (saveBudget/applyCategory/persistPayCycle) fire refreshBudgets to
  // re-sync after a successful save. If that follow-up GET fails it must NOT surface
  // the global read banner on top of the write's own green toast — refreshBudgets is
  // deliberately not self-flagging. (Mount/retry flag it at the call site instead.)
  const result = await mount();
  expect(result.current.loadError).toBe(false);

  mockApi.fetchBudgets.mockRejectedValue(new Error('5xx'));
  await act(async () => { await result.current.refreshBudgets().catch(() => {}); });

  expect(result.current.loadError).toBe(false);
});
