// WHIT-271 round-2 — freshness-window gap for createCategoryInline. The committed
// sessionGuardRollbacksGaps suite proves the late create returns null + no-ops on the CLEARED
// cache; the committed deleteRule freshness test proves the epoch (not the `prev ?` guard) is
// what stops a stale write landing once account B has RE-LOADED its cache. The same window
// exists for createCategoryInline's append `prev ? [...prev, created] : prev` — on B's non-empty
// ['categories'] it would PLANT account A's new category. Nothing pins that. This does.
// Harness mirrors the committed suites: live mini auth store, mocked ../api, real queryClient.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => {
  mockStatus = s;
  mockListeners.forEach((l) => l());
};
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
}));
jest.mock('../api');
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => ({})),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
}));

import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function signOut() {
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 });

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
});

describe('WHIT-271 round-2 — createCategoryInline cannot append the old category into the NEXT account', () => {
  it('[A-CCI-FRESH] a create settling AFTER a different account re-loads its list is dropped, returns null', async () => {
    queryClient.setQueryData(['categories'], [cat('cA', 'Account A only')]);
    const d = deferred<{ id: string; name: string; bucket: string }>();
    mockApi.createCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createCategoryInline({ name: 'New', bucket: 'Living' as never, icon: 'tag' }); });
    signOut();
    // Account B signs in and loads its OWN categories BEFORE the stale create lands.
    act(() => mockSetStatus('authed'));
    queryClient.setQueryData(['categories'], [cat('cB', 'Account B only')]);

    let returned!: unknown;
    await act(async () => { d.resolve({ id: 'cNew', name: 'New', bucket: 'Living' }); returned = await pending; });

    // The append `prev ? [...prev, created] : prev` on B's NON-empty list would plant cNew;
    // only the epoch guard (return null BEFORE the append) drops it. B's list stays untouched.
    expect(returned).toBeNull();
    expect(queryClient.getQueryData<{ id: string }[]>(['categories'])?.map((c) => c.id)).toEqual(['cB']);
    expect(result.current.toast).toBeNull();
  });
});
