// WHIT-638 — the last hand-checked saves in context.tsx move onto the save runner. Today their
// late-failure UNDO still runs after sign-out and leans on guarded updaters (`prev ? … : prev`),
// which only no-op on a CLEARED cache. Once the next account has loaded its own charges, the
// stale undo writes account A's old values over them. The runner skips the undo entirely after
// sign-out; these pin that at the provider (freshness window, mirrors sessionGuardRollbacks).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';

import { useAppContext } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

// Production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
function signOut() {
  act(() => { queryClient.clear(); setAuthStatus('anon'); });
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff' });

beforeEach(() => {
  resetAuth();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

describe('WHIT-638 — a save failing after sign-out cannot undo into the NEXT account', () => {
  it('applyTransactionEdit: a late failure leaves the next account\'s charge note untouched', async () => {
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'old', category: null, counts_to_budget: true, description: 'X' }]);
    const held = server.hold('/transactions/t1');
    server.once('PATCH', '/transactions/t1', 'dropped');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyTransactionEdit('t1', { notes: 'new' }); });
    signOut();
    // The next account signs in and loads its own charges before the stale failure lands.
    act(() => setAuthStatus('authed'));
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'next account', category: null, counts_to_budget: true, description: 'X' }]);
    await act(async () => { held.release(); await pending; });

    expect(readTransactionsCache(queryClient)[0]?.notes).toBe('next account');
    expect(result.current.toast).toBeNull();
  });

  it('applyCategoryToMany: a late failure leaves the next account\'s charge categories untouched', async () => {
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: 'old', counts_to_budget: true, description: 'X' },
      { transaction_id: 't2', category: 'old', counts_to_budget: true, description: 'Y' },
    ]);
    queryClient.setQueryData(['categories'], [cat('old', 'Old'), cat('c1', 'Groceries')]);
    const held = server.hold('/transactions');
    server.once('PATCH', '/transactions', 'dropped');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategoryToMany(['t1', 't2'], 'c1'); });
    signOut();
    act(() => setAuthStatus('authed'));
    seedTransactionsCache(queryClient, [
      { transaction_id: 't1', category: 'fresh', counts_to_budget: true, description: 'X' },
      { transaction_id: 't2', category: 'fresh', counts_to_budget: true, description: 'Y' },
    ]);
    await act(async () => { held.release(); await pending; });

    expect(readTransactionsCache(queryClient).map((t) => t.category)).toEqual(['fresh', 'fresh']);
    expect(result.current.toast).toBeNull();
  });
});
