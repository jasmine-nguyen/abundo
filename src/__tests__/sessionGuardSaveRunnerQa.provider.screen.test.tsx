// WHIT-638 QA — adversarial companions to sessionGuardSaveRunner: the saves moved onto the runner
// must (a) never undo, toast or refresh after sign-out, even once the NEXT account has loaded its
// own data, and (b) keep every in-session undo / toast / rule reconcile / refresh working.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';

import { useAppContext } from '../context';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

// Production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
function signOut() {
  act(() => { queryClient.clear(); setAuthStatus('anon'); });
}
function signInNextAccount() {
  act(() => setAuthStatus('authed'));
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff' });
const updated = (...ids: string[]) => ({ results: ids.map((id) => ({ id, status: 'updated' })) });

function rulesCache() {
  return queryClient.getQueryData<Rule[]>(['rules']) ?? [];
}

function mountWithConfirm(txId: string, categoryId: string) {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  act(() => { result.current.setSheet({ mode: 'confirm', txId, categoryId } as never); });
  return result;
}

beforeEach(() => {
  resetAuth();
  queryClient.clear();
});
afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
});

describe('WHIT-638 QA — after sign-out, nothing leaks into the NEXT account', () => {
  // [A1]
  it("applyCategory('one'): a late failure leaves the next account's category untouched and shows no toast", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const held = server.hold('/transactions/t1');
    const result = mountWithConfirm('t1', 'c1');

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('one'); });
    signOut();
    signInNextAccount();
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'X' }]);
    await act(async () => { held.fail('PATCH'); await pending; });

    expect(readTransactionsCache(queryClient)[0]?.category).toBe('fresh');
    expect(result.current.toast).toBeNull();
  });

  // [A2]
  it("applyCategory('all'): a late batch failure leaves the next account's categories untouched", async () => {
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' },
      { transaction_id: 't2', category: null, counts_to_budget: true, description: 'COLES' },
    ]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    server.once('POST', '/rules', { body: { id: 'r9', value: 'COLES', categoryId: 'c1' } });
    const held = server.hold('/transactions');
    const result = mountWithConfirm('t1', 'c1');

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('all'); });
    signOut();
    signInNextAccount();
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'COLES' },
      { transaction_id: 't2', category: 'fresh', counts_to_budget: true, description: 'COLES' },
    ]);
    const nextRules: Rule[] = [{ id: 'rX', pattern: 'NEXT', categoryId: 'fresh', isNew: false }];
    queryClient.setQueryData(['rules'], nextRules);
    await act(async () => { held.fail('PATCH'); await pending; });

    expect(readTransactionsCache(queryClient).map((t) => t.category)).toEqual(['fresh', 'fresh']);
    expect(rulesCache()).toEqual(nextRules);
    expect(result.current.toast).toBeNull();
  });

  // [A3]
  it("applyCategory('one'): a success settling after sign-out triggers no refresh", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const held = server.hold('/transactions/t1');
    const result = mountWithConfirm('t1', 'c1');

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('one'); });
    signOut();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { held.release(); await pending; });

    expect(invalidatedKeys(spy)).toEqual([]);
  });

  // [A4]
  it('applyCategoryToMany: a success settling after sign-out triggers no refresh', async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const held = server.hold('/transactions');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategoryToMany(['t1'], 'c1'); });
    signOut();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { held.release(); await pending; });

    expect(invalidatedKeys(spy)).toEqual([]);
  });

  // [A5]
  it('applyTransactionEdit (exclude): a success settling after sign-out triggers no refresh', async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
    const held = server.hold('/transactions/t1');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    signOut();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { held.release(); await pending; });

    expect(invalidatedKeys(spy)).toEqual([]);
  });

  // [A6]
  it("applyCategory('all'): a success settling after sign-out triggers no refresh and shows no rule toast", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    server.fail('/rules', 500);
    const held = server.hold('/transactions');
    const result = mountWithConfirm('t1', 'c1');

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('all'); });
    signOut();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { held.release(); await pending; });

    expect(invalidatedKeys(spy)).toEqual([]);
    expect(result.current.toast).toBeNull();
  });

  // [A7]
  it('generateAiInsights: a late failure after sign-out + re-sign-in sets no error on the new session', async () => {
    const held = server.hold('/insights/ai');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.generateAiInsights(null); });
    signOut();
    signInNextAccount();
    await act(async () => { held.fail('POST'); await pending; });

    expect(result.current.aiInsightsError).toBe(false);
    expect(result.current.aiInsightsLoading).toBe(false);
  });
});

describe('WHIT-638 QA — in-session behaviour is unchanged', () => {
  // [A8]
  it("applyCategory('one') failure rolls the category back, toasts, and does not refresh", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: 'old', counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [cat('old', 'Old'), cat('c1', 'Groceries')]);
    server.once('PATCH', '/transactions/t1', 'dropped');
    const result = mountWithConfirm('t1', 'c1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategory('one'); });

    expect(readTransactionsCache(queryClient)[0]?.category).toBe('old');
    expect(result.current.toast).toBe('Could not save category. Please try again.');
    expect(result.current.sheet).toBeNull();
    expect(invalidatedKeys(spy)).toEqual([]);
  });

  // [A9]
  it("applyCategory('one') success keeps the new category and refreshes the refile keys", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: 'old', counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [cat('old', 'Old'), cat('c1', 'Groceries')]);
    const result = mountWithConfirm('t1', 'c1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategory('one'); });

    expect(readTransactionsCache(queryClient)[0]?.category).toBe('c1');
    expect(result.current.toast).toBe('This transaction filed under Groceries.');
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['budgets', 'uncategorizedCount']));
  });

  // [A10]
  it("applyCategory('all') with a saved rule swaps the temp id for the real one and keeps the NEW badge", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    server.once('POST', '/rules', { body: { id: 'r9', value: 'COLES', categoryId: 'c1', field: 'description', operator: 'contains' } });
    const result = mountWithConfirm('t1', 'c1');

    await act(async () => { await result.current.applyCategory('all'); });

    const rules = rulesCache();
    expect(rules.map((r) => r.id)).toEqual(['r9']);
    expect(rules[0]?.isNew).toBe(true);
    expect(readTransactionsCache(queryClient)[0]?.category).toBe('c1');
  });

  // [A11]
  it("applyCategory('all') with a failed rule removes the temp rule, keeps the charges filed, and says so", async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const existing: Rule[] = [{ id: 'rOther', pattern: 'WOOLWORTHS', categoryId: 'c1', isNew: false }];
    queryClient.setQueryData(['rules'], existing);
    server.fail('/rules', 500);
    const result = mountWithConfirm('t1', 'c1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategory('all'); });

    expect(rulesCache()).toEqual(existing);
    expect(readTransactionsCache(queryClient)[0]?.category).toBe('c1');
    expect(result.current.toast).toBe('Filed, but could not save the rule for future charges.');
    expect(invalidatedKeys(spy)).toContain('budgets');
  });

  // [A12]
  it("applyCategory('all') partial batch failure undoes only the failed charge and still refreshes", async () => {
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' },
      { transaction_id: 't2', category: null, counts_to_budget: true, description: 'COLES' },
    ]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    server.once('POST', '/rules', { body: { id: 'r9', value: 'COLES', categoryId: 'c1' } });
    server.once('PATCH', '/transactions', { body: updated('t1') }); // t2 comes back without a result
    const result = mountWithConfirm('t1', 'c1');
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategory('all'); });

    expect(readTransactionsCache(queryClient).map((t) => t.category)).toEqual(['c1', null]);
    expect(result.current.toast).toBe('Could not save some categories. Please try again.');
    expect(invalidatedKeys(spy)).toContain('budgets');
  });

  // [A13]
  it('applyCategoryToMany total failure undoes every charge, toasts, and does not refresh', async () => {
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: 'old', counts_to_budget: true, description: 'X' },
      { transaction_id: 't2', category: 'older', counts_to_budget: true, description: 'Y' },
    ]);
    queryClient.setQueryData(['categories'], [cat('old', 'Old'), cat('older', 'Older'), cat('c1', 'Groceries')]);
    server.fail('/transactions', 500);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'c1'); });

    expect(readTransactionsCache(queryClient).map((t) => t.category)).toEqual(['old', 'older']);
    expect(result.current.toast).toBe('Could not save some categories. Please try again.');
    expect(invalidatedKeys(spy)).toEqual([]);
  });

  // [A14]
  it('applyTransactionEdit note success refreshes nothing; exclude success refreshes the budget keys', async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'old', category: null, counts_to_budget: true, description: 'X' }]);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'new' }); });
    expect(readTransactionsCache(queryClient)[0]?.notes).toBe('new');
    expect(invalidatedKeys(spy)).toEqual([]);

    await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['budgets', 'budgetTransactions']));
    expect(result.current.toast).toBeNull();
  });

  // [A15]
  it('refreshAiInsights failure keeps the insights already shown and raises no error', async () => {
    server.once('GET', '/insights/ai', { body: { summary: 'shown' } });
    const { result } = renderHook(() => useAppContext(), { wrapper });
    await act(async () => { await result.current.refreshAiInsights(); });
    expect(result.current.aiInsights).toEqual({ summary: 'shown' });

    server.once('GET', '/insights/ai', 'dropped');
    await act(async () => { await result.current.refreshAiInsights(); });

    expect(result.current.aiInsights).toEqual({ summary: 'shown' });
    expect(result.current.aiInsightsError).toBe(false);
  });

  // [A16]
  it('generateAiInsights: success seats data and clears the spinner; failure flags the error and clears it', async () => {
    server.once('POST', '/insights/ai', { body: { summary: 'fresh' } });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.generateAiInsights(null); });
    expect(result.current.aiInsights).toEqual({ summary: 'fresh' });
    expect(result.current.aiInsightsLoading).toBe(false);
    expect(result.current.aiInsightsError).toBe(false);

    server.once('POST', '/insights/ai', 'dropped');
    await act(async () => { await result.current.generateAiInsights(null); });
    expect(result.current.aiInsightsError).toBe(true);
    expect(result.current.aiInsightsLoading).toBe(false);
    expect(result.current.aiInsights).toEqual({ summary: 'fresh' });
  });
});
