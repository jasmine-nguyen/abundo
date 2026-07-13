// WHIT-266 — adversarial GAP tests for the "keep the app mounted under the lock cover" slice.
// The implementer's authGateLockCover.screen.test.tsx locks down the single lock→unlock cycle
// (no remount, opaque/on-top cover, a11y-hidden, keyboard dismissed, cold-launch redirect).
// This suite adds the edges it does NOT cover:
//   [G1] locked ON THE INDEX ROUTE: the lock cover and the WHIT-265 redirect cover are mutually
//        exclusive (gateRedirect returns null while locked, so an authed-would-redirect route
//        stays quiet under the lock) — and unlocking RELEASES the legitimate budgets redirect
//        (lock doesn't permanently suppress it).
//   [G2] Sign-in-again FROM the lock screen (→ anon): the still-mounted app is never rebuilt,
//        the lock cover is replaced by the opaque login-redirect cover, and the redirect to '/'
//        fires — a signed-out user is covered + redirected, never mounted-and-visible.
//   [G4] repeated lock→unlock→lock→unlock keeps the SAME app instance (mount counter stays 1).
// Mirrors the authGateLock harness: mock ../auth to drive getStatus; keep gateRedirect REAL
// (jest.requireActual); mock expo-router; spy AppState.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React, { useEffect } from 'react';
import { Text, StyleSheet, AppState } from 'react-native';
import { render, screen, act, fireEvent } from '@testing-library/react-native';
import { C } from '../theme';

const mockRedirectSpy = jest.fn();
let mockSegments: string[] = ['(tabs)', 'budgets'];
jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => { mockRedirectSpy(props.href); return null; },
  useSegments: () => mockSegments,
  useRootNavigationState: () => ({ key: 'root' }),
}));

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
function setStatus(s: typeof mockStatus) {
  mockStatus = s;
  mockListeners.forEach((l) => l());
}
const mockUnlock = jest.fn(async () => { setStatus('authed'); return true; });
const mockLock = jest.fn(() => setStatus('locked'));
const mockSignOut = jest.fn(async () => setStatus('anon'));

jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // real gateRedirect
    getStatus: () => mockStatus,
    subscribe: (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); },
    unlockOrRestore: async () => {},
    canBiometricLock: () => true,
    unlock: () => mockUnlock(),
    lock: () => mockLock(),
    signOut: () => mockSignOut(),
  };
});

import { AuthGate } from '../AuthGate';

// Counts its own mounts — the direct probe for "the app is not rebuilt". Pre-WHIT-266 the
// locked branch returned <LockScreen/> INSTEAD of the children, so a lock unmounted this and a
// later unlock re-mounted it (bumping the counter past 1).
let childMounts = 0;
function MountCounter() {
  useEffect(() => { childMounts += 1; }, []);
  return <Text testID="child">app</Text>;
}

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockUnlock.mockReset().mockImplementation(async () => { setStatus('authed'); return true; });
  mockLock.mockClear();
  mockSignOut.mockReset().mockImplementation(async () => setStatus('anon'));
  mockListeners.clear();
  mockStatus = 'authed';
  mockSegments = ['(tabs)', 'budgets'];
  childMounts = 0;
  process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED = 'true';
  process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() } as never));
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
  jest.restoreAllMocks();
});

function renderGate() {
  return render(
    <AuthGate>
      <MountCounter />
    </AuthGate>,
  );
}

describe('WHIT-266 lock cover — adversarial gaps', () => {
  // [G1] locked on the INDEX route: the two covers never co-occur, and unlock releases the
  // legitimate authed+index → budgets redirect. gateRedirect returns null while locked, so even
  // sitting where an authed user WOULD be bounced, no redirect cover competes with the lock.
  it('[G1] locked on index: only the lock cover (no redirect cover / no redirect); unlock releases the budgets redirect', () => {
    mockSegments = []; // the index route — where an AUTHED user is redirected to budgets
    mockStatus = 'locked'; // cold launch straight into a locked session
    renderGate();

    // While locked: lock cover up, NO redirect cover, and gateRedirect emitted NOTHING —
    // the lock status suppresses the redirect so the two covers are mutually exclusive.
    expect(screen.getByTestId('lock-cover')).toBeTruthy();
    expect(screen.queryByTestId('gate-cover')).toBeNull();
    expect(mockRedirectSpy).not.toHaveBeenCalled();
    // App is mounted underneath (hidden from screen readers), not replaced by the lock screen.
    expect(screen.queryByTestId('child')).toBeNull();
    expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();

    // Unlock: authed + on index → the SUPPRESSED redirect is now released.
    act(() => setStatus('authed'));
    expect(screen.queryByTestId('lock-cover')).toBeNull();
    expect(mockRedirectSpy).toHaveBeenCalledWith('/(tabs)/budgets');
    expect(screen.getByTestId('gate-cover')).toBeTruthy();
  });

  // [G2] Sign-in-again from the lock screen (anon). A signed-out user must be COVERED and
  // redirected to login — never left mounted-and-visible — and the app must not be rebuilt.
  it('[G2] sign-in-again from lock: app never remounts, lock cover → opaque login-redirect cover, redirect to /', () => {
    mockSegments = ['(tabs)', 'settings']; // deep protected route
    mockStatus = 'authed';
    renderGate();
    expect(childMounts).toBe(1);

    act(() => setStatus('locked'));
    expect(screen.getByTestId('lock-cover')).toBeTruthy();
    mockRedirectSpy.mockClear();

    // Press "Sign in again" on the lock screen → signOut → anon.
    fireEvent.press(screen.getByText('Sign in again'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);

    // anon on a protected route: lock cover gone, the opaque login-redirect cover is up, and
    // exactly one redirect to the login screen fired.
    expect(screen.queryByTestId('lock-cover')).toBeNull();
    const cover = screen.getByTestId('gate-cover');
    expect(mockRedirectSpy).toHaveBeenCalledWith('/');
    // The cover is opaque (C.bg) so the signed-out app is not visible behind it.
    const coverStyle = StyleSheet.flatten(cover.props.style);
    expect(coverStyle.backgroundColor).toBe(C.bg);
    // The app was covered/redirected, NOT torn down and rebuilt (state preserved end-to-end).
    expect(childMounts).toBe(1);
  });

  // [G4] Repeated lock→unlock cycles: the app instance is built exactly once. A per-cycle
  // remount bug (e.g. re-introducing the unmount-on-locked branch) bumps this past 1.
  it('[G4] repeated lock→unlock→lock→unlock keeps the same app instance (mount counter stays 1)', () => {
    mockStatus = 'authed';
    renderGate();
    expect(childMounts).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      act(() => setStatus('locked'));
      expect(screen.getByTestId('lock-cover')).toBeTruthy();
      expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
      act(() => setStatus('authed'));
      expect(screen.queryByTestId('lock-cover')).toBeNull();
      expect(screen.getByTestId('child')).toBeTruthy();
    }
    expect(childMounts).toBe(1); // one build, zero rebuilds across all three cycles
  });
});
