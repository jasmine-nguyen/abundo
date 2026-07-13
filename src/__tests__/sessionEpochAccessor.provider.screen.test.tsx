// WHIT-282 — GAP: the REAL getSessionEpoch() accessor reads the LIVE session stamp.
// The mocked category-edit screen tests hardcode `getSessionEpoch: () => mockEpoch`, so they
// never exercise the accessor added to src/context.tsx; and the WHIT-271 provider tests
// (sessionGuardRollbacksGaps.provider.screen.test.tsx) exercise the writers' INTERNAL
// sessionEpoch.current guards, never the public accessor. This file renders the REAL AppProvider
// and proves getSessionEpoch() returns the live ref value across a sign-out broadcast — including
// through a STALE context reference captured BEFORE the sign-out (the exact shape app/category/
// edit.tsx relies on: it captures `s` at render and re-reads s.getSessionEpoch() across the
// await). Harness mirrors sessionGuardRollbacksGaps.provider.screen.test.tsx.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
// Broadcast like production setStatus, but faithfully: only notify when the status ACTUALLY
// changes (auth.ts setStatus early-returns when next === status), so a repeat 'anon' can't
// double-bump the epoch here in a way production never would.
const mockSetStatus = (s: typeof mockStatus) => {
  if (s === mockStatus) return;
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

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// Sign out in PRODUCTION order: clear the cache, THEN broadcast 'anon' — which the context's
// subscription turns into the sessionEpoch bump.
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

beforeEach(() => { mockStatus = 'authed'; mockListeners.clear(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

// [A-EPOCH-LIVE] The accessor reads the LIVE ref. A sign-out (broadcast 'anon') bumps the epoch,
// and getSessionEpoch() returns the NEW value — even through the SAME reference captured BEFORE
// the sign-out (exactly how app/category/edit.tsx re-reads s.getSessionEpoch() across the await).
// Fail-on-revert: make getSessionEpoch capture a snapshot instead of reading .current (e.g.
// `useCallback(() => 0, [])`) → the post-sign-out read stays equal to `before` → this test fails.
it('getSessionEpoch() reflects the live session stamp across a sign-out, even via a stale reference', () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });

  const s = result.current;               // the stale reference the screen holds across an await
  const before = s.getSessionEpoch();

  signOut();

  // The SAME captured reference, re-read after the bump, must report the new live value.
  expect(s.getSessionEpoch()).not.toBe(before);
  expect(s.getSessionEpoch()).toBe(before + 1);
});

// [A-EPOCH-LOCK] Acceptable-for-scope contract: a Face ID LOCK is NOT a session change, so the
// subscription's `getStatus() !== 'anon'` guard skips the bump and getSessionEpoch() is UNCHANGED
// — a save spanning a lock/unlock of the SAME account still completes (WHIT-282 only aborts on a
// genuine session swap). Documents WHY lock does not abort the category-edit save.
it('getSessionEpoch() does NOT change on a lock broadcast (same-session lock is not an abort)', () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });

  const s = result.current;
  const before = s.getSessionEpoch();

  act(() => { mockSetStatus('locked'); });

  expect(s.getSessionEpoch()).toBe(before);
});
