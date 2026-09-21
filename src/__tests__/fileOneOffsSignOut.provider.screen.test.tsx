// WHIT-544 — the sign-out reset the screen tests can't reach: a one-shot "jump into multi-select"
// intent armed but NOT yet consumed must NOT carry into the next session. Drives the REAL AppProvider
// (../auth + ../api mocked) with a live miniature auth store so the anon broadcast runs the real
// sign-out subscription. Mirrors saveMilestonesSignOut.provider's harness.
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

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// Production sign-out order: clear the cache, THEN broadcast anon (which the context subscription
// turns into the reset). Matches saveMilestonesSignOut.signOut.
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

beforeEach(() => { mockStatus = 'authed'; mockListeners.clear(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('WHIT-544 — a pending Uncategorized-select intent is dropped on sign-out', () => {
  // Arm the jump, then sign out WITHOUT the Transactions screen ever consuming it (it may not be
  // mounted, or the app redirected to login first). The flag must be false in the next session, or
  // the freshly-signed-in user is dumped into selection mode for no reason.
  // GENUINE FAIL-ON-REVERT: remove `setPendingUncategorizedSelect(false)` from the anon branch of the
  // auth subscription and the flag stays true across the session boundary → this reddens.
  it('resets pendingUncategorizedSelect to false when the session ends', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.requestUncategorizedSelect(); });
    expect(result.current.pendingUncategorizedSelect).toBe(true); // armed

    signOut();

    expect(result.current.pendingUncategorizedSelect).toBe(false); // dropped, not carried forward
  });

  // Sanity twin: clearUncategorizedSelect() (the screen's own consume path) also flips it false, so
  // the two disarm routes agree. Fail-on-revert: make clearUncategorizedSelect a no-op and this reddens.
  it('clearUncategorizedSelect() disarms the intent (the consume path)', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.requestUncategorizedSelect(); });
    expect(result.current.pendingUncategorizedSelect).toBe(true);

    act(() => { result.current.clearUncategorizedSelect(); });
    expect(result.current.pendingUncategorizedSelect).toBe(false);
  });
});
