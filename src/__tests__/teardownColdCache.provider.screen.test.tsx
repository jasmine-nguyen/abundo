// WHIT-192 GAPS — the teardown's NEW failure mode: a writer runs while the query cache the
// eager store used to guarantee is COLD (never loaded / evicted). Complements
// storeReaderWrites / appProvider / transactionsCategorize / rulesWrite(Gaps) / loanFactsWrite,
// which all SEED a warm cache. Here every writer sources its reads from a cold cache and must
// bail or no-op gracefully — never corrupt the cache or fire a defaulted server write. Drives
// the REAL writers via AppProvider + the singleton queryClient (../auth mocked + the fake server).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Category } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { appProviderWrapper as wrapper } from './support/renderWithApp';
import { colesTxn as txn } from './factory';

const server = installFakeServer();

const CAT: Category = { ...GROCERIES };

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// --- persistPayCycle: cold ['payCycle'] cache must BAIL, not persist a defaulted cycle ------

it('setPayCycleLength bails on a cold [payCycle] cache — no server write, no corrupt cache', async () => {
  // The pay-cycle sheet warms ['payCycle'] on open; if a change fires before that resolved,
  // persisting mutate({length}) over an undefined prev would drop the sibling last_pay_date.
  const result = mount(); // NO ['payCycle'] seed

  await act(async () => { result.current.setPayCycleLength(30); });

  expect(server.sent('PUT', '/paycycle')).toHaveLength(0);              // <-- fails on revert of the !prev guard
  expect(queryClient.getQueryData(['payCycle'])).toBeUndefined(); // no half-built cycle written
});

// --- applyCategory: cold ['transactions']/['categories'] must no-op (close the sheet) --------

it('applyCategory(all) no-ops on a cold cache — mints no rule, sends no batch', async () => {
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }); });

  await act(async () => { await result.current.applyCategory('all'); });

  expect(server.sent('POST', '/rules')).toHaveLength(0);
  expect(server.sent('PATCH', '/transactions')).toHaveLength(0);
  expect(result.current.sheet).toBeNull();
});

it('applyCategory no-ops when transactions are warm but the taxonomy is cold (partial cold)', async () => {
  // The tx exists, but the chosen category can't be resolved (['categories'] never loaded) →
  // the category lookup fails and the write must bail rather than file under an unknown id.
  seedTransactionsCache(queryClient, [txn({ transaction_id: 't1' })]);
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }); });

  await act(async () => { await result.current.applyCategory('one'); });

  expect(server.sent('PATCH', '/transactions/t1')).toHaveLength(0);
  expect(result.current.sheet).toBeNull();
});

// --- saveBudget: cold-cache toast lookups must degrade gracefully, not crash ------------------

it('saveBudget still saves on a cold [categories] cache — returns true, no crash, no success toast', async () => {
  // The toast copy needs the category name from ['categories']; cold → no name → the write
  // still persists (the Budgets screen invalidates + reconciles), it just shows no toast.
  const result = mount(); // NO categories/budgets seed

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });

  expect(ok).toBe(true);
  expect(server.requests()).toContainEqual({ method: 'PUT', path: '/budgets/groceries', body: { target: 300 } });
  expect(result.current.toast).toBeNull(); // no category name → no success toast (no thrown lookup)
});

// --- saveManualRule: cold [categories] toast lookup is graceful; rule still lands -------------

it('saveManualRule writes the rule but shows no toast when [categories] is cold', async () => {
  // Rules cache warm (so patchRules has something to patch), categories cold → the name lookup
  // returns undefined and the success toast is skipped, but the rule is still created + cached.
  server.once('POST', '/rules', { body: { id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' } });
  queryClient.setQueryData<Rule[]>(['rules'], []);
  const result = mount(); // NO categories seed

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(server.requests()).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'spotify', categoryId: 'subs', budgetExcluded: false, spread: false } });
  expect(queryClient.getQueryData<Rule[]>(['rules'])?.[0]).toMatchObject({ id: 'e9', isNew: true });
  expect(result.current.toast).toBeNull(); // cold taxonomy → no "Rule added — …" toast, no crash
});

// --- updateRule: cold ['rules'] cache means no `before` snapshot → bail, no server write -------

it('updateRule bails on a cold [rules] cache — no PUT, no toast, cache untouched', async () => {
  const result = mount(); // NO rules seed

  await act(async () => { await result.current.updateRule('e1', 'DISNEY', 'subs'); });

  expect(server.sent('PUT', '/rules/e1')).toHaveLength(0);  // no `before` → guarded early return
  // Assert the early return fired, not merely that the (undefined before.field) PUT threw:
  // removing the `if (!before) return` guard surfaces the caught-error toast + touches nothing,
  // so a null toast + absent cache only hold when the guard short-circuits.
  expect(result.current.toast).toBeNull();
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
});
