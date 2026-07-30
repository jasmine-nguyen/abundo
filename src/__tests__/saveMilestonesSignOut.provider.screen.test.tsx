// WHIT-377 — the ADVERSARIAL half of saveMilestones the implementer left to QA. Two gaps its own
// provider test (saveMilestones.provider) does NOT cover:
//   1. Sign-out mid-flight (WHIT-271 parity): a save that settles AFTER the session ends must be a
//      no-op — no re-seat of the old plan into the cleared cache, no toast into the next session,
//      and it must return false (a truthy return would fire the editor's router.back() post-redirect).
//   2. The client-minted id on a new row survives the optimistic write unchanged (server preserves
//      supplied ids) — saveMilestones REPLACES the list, it must not merge/append/regenerate ids.
// Harness mirrors sessionGuardRollbacks.provider.screen: a live miniature auth store (so the anon
// broadcast actually bumps the session epoch), mocked ../api, the real singleton queryClient.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
}));
jest.mock('../api');

import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';
import type { MilestoneRecord } from '../api';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// A deferred whose resolve/reject the test controls, so the writer is genuinely in-flight when the
// session ends (mirrors sessionGuardRollbacks' deferred).
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Sign out in PRODUCTION order: clear the cache, THEN broadcast anon (which the context subscription
// turns into the epoch bump). Matches sessionGuardRollbacks.signOut.
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

const PREV: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];
const NEXT: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Middle', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];
const cached = () => queryClient.getQueryData<MilestoneRecord[]>(['milestones']);

beforeEach(() => { mockStatus = 'authed'; mockListeners.clear(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('WHIT-377 — saveMilestones settling AFTER sign-out is a no-op', () => {
  it('SUCCESS after sign-out: no invalidate re-seat, no toast, returns false', async () => {
    queryClient.setQueryData(['milestones'], PREV);
    const d = deferred<MilestoneRecord[]>();
    mockApi.setMilestones.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveMilestones(NEXT); }); // optimistic write → cache = NEXT
    signOut();                                                      // clears cache + bumps epoch
    let returned!: boolean;
    await act(async () => { d.resolve(NEXT); returned = await pending; });

    expect(returned).toBe(false);              // <-- no stray router.back() after the login redirect
    expect(cached()).toBeUndefined();          // the cleared cache is NOT re-populated by a late invalidate/write
    expect(result.current.toast).toBeNull();
  });

  it('FAILURE after sign-out: old plan is NOT re-seated into the cleared cache, no toast, returns false', async () => {
    queryClient.setQueryData(['milestones'], PREV);
    const d = deferred<MilestoneRecord[]>();
    mockApi.setMilestones.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveMilestones(NEXT); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(returned).toBe(false);
    expect(cached()).toBeUndefined();          // <-- the catch's setQueryData(prev) is skipped by the epoch guard
    expect(result.current.toast).toBeNull();   // no "Could not save milestones" into the next session
  });
});

describe('WHIT-377 — the client-minted id survives the optimistic write', () => {
  it('REPLACES the list and preserves the supplied new-row id exactly once (no merge/append/regen)', async () => {
    queryClient.setQueryData(['milestones'], PREV);        // an existing 2-row plan
    mockApi.setMilestones.mockResolvedValue(NEXT);         // server echoes the list back unchanged
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let ok!: boolean;
    await act(async () => { ok = await result.current.saveMilestones(NEXT); });

    expect(ok).toBe(true);
    const rows = cached()!;
    expect(rows).toEqual(NEXT);                             // full replace — not [...PREV, ...NEXT]
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']); // the client-minted 'c' is present ONCE, unchanged
  });
});
