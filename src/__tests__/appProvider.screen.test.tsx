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
  mockApi.listEnrichments.mockResolvedValue([]);
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
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(3));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategory).toHaveBeenCalledTimes(2);   // t1 + t2 only, NOT t3
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
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  const result = await mount();
  await waitFor(() => expect(result.current.transactions).toHaveLength(3));

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // t1 (null) + t2 (raw enum) swept; t3 (already groceries) left alone.
  const swept = mockApi.setTransactionCategory.mock.calls.map((c) => c[0]).sort();
  expect(swept).toEqual(['t1', 't2']);
  const byId = Object.fromEntries(result.current.transactions.map((t) => [t.transaction_id, t.category]));
  expect(byId.t2).toBe('groceries');   // the FOOD_AND_DRINK charge is now filed
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
