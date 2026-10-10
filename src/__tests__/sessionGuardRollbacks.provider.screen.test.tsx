// WHIT-271 / WHIT-638 — a save/toast that settles AFTER sign-out must be a no-op: it must not
// write the old account's data into the next account's cache, toast into the next session, or
// return success (the edit screens toast + navigate on a truthy return). Every row signs out,
// lets the NEXT account load its own data, and only then settles the stale save — so only the
// session-epoch guard (not a `prev ? … : prev` updater) can keep that data untouched.
// Harness: live miniature auth store, the fake server, the real queryClient.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';

import { useAppContext } from '../context';
import type { Bucket } from '../types';
import type { Method } from './support/fakeServer';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

// Sign out in PRODUCTION order: clearSession() wipes the cache, THEN broadcasts anon (which the
// context's subscription turns into the epoch bump).
function signOut() {
  act(() => { queryClient.clear(); setAuthStatus('anon'); });
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff' });
const FORM = { name: 'Gym', bucket: 'Lifestyle' as Bucket, icon: 'dumbbell' };
const SILENT = { silent: true };
// setPayCycleLength returns void, so wait one macrotask for its request and catch to settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const categoryIds = () => readTransactionsCache(queryClient).map((t) => t.category);

beforeEach(() => {
  resetAuth();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

type Ctx = ReturnType<typeof useAppContext>;
type SignOutRow = {
  name: string;
  seed?: () => void; // the signed-out account's cache (and any extra server replies)
  send: [Method, string];
  fail?: true; // the server drops the request
  before?: (c: Ctx) => void;
  run: (c: Ctx) => unknown;
  next?: () => void; // the next account's freshly loaded data
  read?: () => unknown;
  expected?: unknown;
  returns?: unknown;
};

const SIGN_OUT_ROWS: SignOutRow[] = [
  {
    name: 'setPayCycleLength',
    seed: () => queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-06-06' }),
    send: ['PUT', '/paycycle'], fail: true,
    run: (c) => c.setPayCycleLength(30),
    next: () => queryClient.setQueryData(['payCycle'], { length: 7, last_pay_date: '2026-07-10' }),
    read: () => queryClient.getQueryData(['payCycle']),
    expected: { length: 7, last_pay_date: '2026-07-10' },
  },
  {
    name: 'saveLoanFacts',
    seed: () => queryClient.setQueryData(['loanFacts'], { balance: 111, rate: 5 }),
    send: ['PUT', '/loanfacts'], fail: true,
    run: (c) => c.saveLoanFacts({ balance: 222, rate: 6 } as never),
    next: () => queryClient.setQueryData(['loanFacts'], { balance: 333, rate: 7 }),
    read: () => queryClient.getQueryData(['loanFacts']),
    expected: { balance: 333, rate: 7 },
    returns: false,
  },
  {
    name: 'saveGoal (success)',
    seed: () => queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]),
    send: ['PUT', '/goals/g1'],
    run: (c) => c.saveGoal('g1', { target: 200 } as never),
    next: () => queryClient.setQueryData(['goals'], [{ id: 'g1', target: 999 }]),
    read: () => queryClient.getQueryData(['goals']),
    expected: [{ id: 'g1', target: 999 }],
  },
  {
    name: 'deleteGoal',
    seed: () => queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]),
    send: ['DELETE', '/goals/g1'], fail: true,
    run: (c) => c.deleteGoal('g1'),
    next: () => queryClient.setQueryData(['goals'], [{ id: 'g2', target: 50 }]),
    read: () => queryClient.getQueryData(['goals']),
    expected: [{ id: 'g2', target: 50 }],
    returns: false,
  },
  {
    // The success toast would name the OLD account's category and dollar figure.
    name: 'saveBudget (success)',
    seed: () => queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]),
    send: ['PUT', '/budgets/c1'],
    run: (c) => c.saveBudget('c1', 500),
    returns: false,
  },
  {
    name: 'saveCategory (success)',
    seed: () => queryClient.setQueryData(['categories'], [cat('c1', 'Old')]),
    send: ['PATCH', '/categories/c1'],
    run: (c) => c.saveCategory('c1', { name: 'New', bucket: 'Living' as never, icon: 'tag' }),
    next: () => queryClient.setQueryData(['categories'], [cat('c1', 'Account B')]),
    read: () => queryClient.getQueryData(['categories']),
    expected: [cat('c1', 'Account B')],
    returns: false,
  },
  {
    name: 'createCategoryInline (success)',
    seed: () => {
      queryClient.setQueryData(['categories'], [cat('cA', 'Account A only')]);
      server.once('POST', '/categories', { body: { id: 'cNew', name: 'New', bucket: 'Living' } });
    },
    send: ['POST', '/categories'],
    run: (c) => c.createCategoryInline({ name: 'New', bucket: 'Living' as never, icon: 'tag' }),
    next: () => queryClient.setQueryData(['categories'], [cat('cB', 'Account B only')]),
    read: () => queryClient.getQueryData(['categories']),
    expected: [cat('cB', 'Account B only')],
    returns: null,
  },
  {
    name: 'deleteCategory',
    seed: () => queryClient.setQueryData(['categories'], [cat('c1', 'Old')]),
    send: ['DELETE', '/categories/c1'], fail: true,
    run: (c) => c.deleteCategory('c1'),
    returns: false,
  },
  {
    name: 'deleteRule',
    seed: () => queryClient.setQueryData(['rules'], [{ id: 'rA', pattern: 'COLES', categoryId: 'cA', isNew: false }]),
    send: ['DELETE', '/rules/rA'], fail: true,
    run: (c) => c.deleteRule('rA'),
    next: () => queryClient.setQueryData(['rules'], [{ id: 'rB', pattern: 'WOOLIES', categoryId: 'cB', isNew: false }]),
    read: () => queryClient.getQueryData(['rules']),
    expected: [{ id: 'rB', pattern: 'WOOLIES', categoryId: 'cB', isNew: false }],
  },
  {
    name: 'saveManualRule',
    seed: () => {
      queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
      queryClient.setQueryData(['rules'], []);
    },
    send: ['POST', '/rules'], fail: true,
    run: (c) => c.saveManualRule('COLES', 'c1'),
    next: () => queryClient.setQueryData(['rules'], [{ id: 'rB', pattern: 'WOOLIES', categoryId: 'cB', isNew: false }]),
    read: () => queryClient.getQueryData(['rules']),
    expected: [{ id: 'rB', pattern: 'WOOLIES', categoryId: 'cB', isNew: false }],
  },
  {
    name: 'updateRule',
    seed: () => {
      queryClient.setQueryData(['rules'], [{ id: 'r1', pattern: 'OLD', categoryId: 'c1', isNew: false, field: 'description', operator: 'contains' }]);
      queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    },
    send: ['PUT', '/rules/r1'], fail: true,
    run: (c) => c.updateRule('r1', 'NEW', 'c1'),
  },
  {
    name: 'applyTransactionEdit',
    seed: () => seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'old', category: null, counts_to_budget: true, description: 'X' }]),
    send: ['PATCH', '/transactions/t1'], fail: true,
    run: (c) => c.applyTransactionEdit('t1', { notes: 'new' }),
    next: () => seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'next account', category: null, counts_to_budget: true, description: 'X' }]),
    read: () => readTransactionsCache(queryClient).map((t) => t.notes),
    expected: ['next account'],
  },
  {
    name: "applyCategory('one')",
    seed: () => {
      seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
      queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    },
    send: ['PATCH', '/transactions/t1'], fail: true,
    before: (c) => c.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'c1' } as never),
    run: (c) => c.applyCategory('one'),
    next: () => seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'X' }]),
    read: categoryIds,
    expected: ['fresh'],
  },
  {
    name: "applyCategory('all')",
    seed: () => {
      seedTransactionsCache(queryClient, [
        { transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' },
        { transaction_id: 't2', category: null, counts_to_budget: true, description: 'COLES' },
      ]);
      queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
      queryClient.setQueryData(['rules'], []);
      server.once('POST', '/rules', { body: { id: 'r9', value: 'COLES', categoryId: 'c1' } });
    },
    send: ['PATCH', '/transactions'], fail: true,
    before: (c) => c.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'c1' } as never),
    run: (c) => c.applyCategory('all'),
    next: () => {
      seedTransactionsCache(queryClient, [
        { transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'COLES' },
        { transaction_id: 't2', category: 'fresh', counts_to_budget: true, description: 'COLES' },
      ]);
      queryClient.setQueryData(['rules'], [{ id: 'rX', pattern: 'NEXT', categoryId: 'fresh', isNew: false }]);
    },
    read: () => [categoryIds(), queryClient.getQueryData(['rules'])],
    expected: [['fresh', 'fresh'], [{ id: 'rX', pattern: 'NEXT', categoryId: 'fresh', isNew: false }]],
  },
  {
    name: 'applyCategoryToMany',
    seed: () => {
      seedTransactionsCache(queryClient, [
        { transaction_id: 't1', category: 'old', counts_to_budget: true, description: 'X' },
        { transaction_id: 't2', category: 'old', counts_to_budget: true, description: 'Y' },
      ]);
      queryClient.setQueryData(['categories'], [cat('old', 'Old'), cat('c1', 'Groceries')]);
    },
    send: ['PATCH', '/transactions'], fail: true,
    run: (c) => c.applyCategoryToMany(['t1', 't2'], 'c1'),
    next: () => seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'X' },
      { transaction_id: 't2', category: 'fresh', counts_to_budget: true, description: 'Y' },
    ]),
    read: categoryIds,
    expected: ['fresh', 'fresh'],
  },
];

it.each(SIGN_OUT_ROWS)(
  "$name: a save settling after sign-out, with the next account already loaded, leaves that account's cache untouched, shows no toast, and returns its signed-out value",
  async (row) => {
    row.seed?.();
    const [method, path] = row.send;
    const held = server.hold(path);
    if (row.fail) server.once(method, path, 'dropped');
    const { result } = renderHook(() => useAppContext(), { wrapper });
    if (row.before) act(() => row.before!(result.current));

    let pending: unknown;
    act(() => { pending = row.run(result.current); });
    signOut();
    act(() => setAuthStatus('authed'));
    row.next?.();
    let returned: unknown;
    await act(async () => { held.release(); returned = await pending; await settle(); });

    expect(server.sent(method, path)).toHaveLength(1);
    if (row.read) expect(row.read()).toEqual(row.expected);
    expect(result.current.toast).toBeNull();
    if ('returns' in row) expect(returned).toBe(row.returns);
  },
);

// [A21][A22] Guarded BEFORE the try, so a blank name can't reach the request or the throw.
// Overlays/QuickCreateCategory trim independently of edit.tsx's canSave.
it.each([
  ['createCategoryInline({ name: "   " })', (c: Ctx) => c.createCategoryInline({ ...FORM, name: '   ' }, SILENT), null, 'POST', '/categories'],
  ['saveCategory(null, { name: "" })', (c: Ctx) => c.saveCategory(null, { ...FORM, name: '' }, SILENT), false, 'POST', '/categories'],
  ['saveCategory("gym", { name: "   " })', (c: Ctx) => c.saveCategory('gym', { ...FORM, name: '   ' }, SILENT), false, 'PATCH', '/categories/gym'],
] as const)('%s with { silent: true } resolves %s and never calls the API', async (_name, call, expected, method, path) => {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  let returned: unknown = 'unset';
  await act(async () => {
    returned = await call(result.current).then((v) => v, (e: unknown) => ({ threw: e }));
  });
  expect(returned).toBe(expected);
  expect(server.sent(method, path)).toHaveLength(0);
  expect(result.current.toast).toBeNull();
});
