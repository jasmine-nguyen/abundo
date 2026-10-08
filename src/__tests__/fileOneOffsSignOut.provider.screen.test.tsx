// WHIT-544 — the sign-out reset the screen tests can't reach: a one-shot "jump into multi-select"
// intent armed but NOT yet consumed must NOT carry into the next session. Drives the REAL AppProvider
// (../auth mocked, the fake server behind ../api) with a live miniature auth store so the anon broadcast runs the real
// sign-out subscription. Mirrors saveMilestonesSignOut.provider's harness.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';

import { useAppContext } from '../context';
import { queryClient } from '../queryClient';
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

installFakeServer();

// Production sign-out order: clear the cache, THEN broadcast anon (which the context subscription
// turns into the reset). Matches saveMilestonesSignOut.signOut.
function signOut() { act(() => { queryClient.clear(); setAuthStatus('anon'); }); }

beforeEach(() => { resetAuth(); queryClient.clear(); });
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
