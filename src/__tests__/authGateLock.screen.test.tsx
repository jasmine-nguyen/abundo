// WHIT-161 — the AuthGate biometric lock behaviour. gateRedirect stays REAL; the
// auth session functions are mocked so we can drive status. AppState is spied so we
// can fire resume transitions. Covers: locked → lock screen; Unlock/Sign-in-again;
// resume re-lock on background→active; the NO-LOOP guard on inactive→active; and
// flag-off preserving WHIT-160.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text, AppState } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockRedirectSpy = jest.fn();
jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => {
    mockRedirectSpy(props.href);
    return null;
  },
  useSegments: () => ['(tabs)', 'budgets'],
  useRootNavigationState: () => ({ key: 'root' }),
}));

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'locked';
const mockListeners = new Set<() => void>();
function setMockStatus(s: typeof mockStatus) {
  mockStatus = s;
  mockListeners.forEach((l) => l());
}
const mockUnlock = jest.fn(async () => {
  setMockStatus('authed');
  return true;
});
const mockLock = jest.fn(() => setMockStatus('locked'));
const mockUnlockOrRestore = jest.fn(async () => {});
const mockCanBiometric = jest.fn(() => true);
const mockSignOut = jest.fn(async () => setMockStatus('anon'));

jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // real gateRedirect
    getStatus: () => mockStatus,
    subscribe: (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); },
    restoreSession: async () => {},
    unlockOrRestore: () => mockUnlockOrRestore(),
    canBiometricLock: () => mockCanBiometric(),
    unlock: () => mockUnlock(),
    lock: () => mockLock(),
    signOut: () => mockSignOut(),
  };
});

import { AuthGate } from '../AuthGate';

let appStateHandler: (s: string) => void;

function renderGate() {
  return render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
}

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockUnlock.mockReset().mockImplementation(async () => { setMockStatus('authed'); return true; });
  mockLock.mockClear();
  mockUnlockOrRestore.mockClear();
  mockSignOut.mockClear();
  mockCanBiometric.mockReturnValue(true);
  mockListeners.clear();
  mockStatus = 'locked';
  process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED = 'true';
  process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
    appStateHandler = cb as unknown as (s: string) => void;
    return { remove: jest.fn() } as never;
  });
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
  jest.restoreAllMocks();
});

it('renders the lock screen over the still-mounted app when a session is locked', () => {
  // WHIT-266: the app now stays MOUNTED under an opaque cover (so scroll/form state
  // survives), instead of being unmounted and replaced by the lock screen.
  renderGate();
  expect(screen.getByText('Whittle is locked')).toBeTruthy();
  expect(screen.getByTestId('lock-cover')).toBeTruthy();
  // The app stays MOUNTED (so scroll/form state survives unlock) but is hidden from screen
  // readers while locked: the default a11y-respecting query can't see it; includeHiddenElements
  // reveals it's still in the tree.
  expect(screen.queryByTestId('child')).toBeNull();
  expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
});

it('reveals the app after a successful Unlock', () => {
  renderGate();
  fireEvent.press(screen.getByText('Unlock'));
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('child')).toBeTruthy();
});

it('keeps the lock screen (with a working retry) when Unlock is cancelled', () => {
  mockUnlock.mockImplementation(async () => false); // cancelled — status stays 'locked'
  renderGate();
  fireEvent.press(screen.getByText('Unlock'));
  expect(mockUnlock).toHaveBeenCalled();
  expect(screen.getByText('Whittle is locked')).toBeTruthy();
  // Still locked → app stays mounted under the cover, hidden from screen readers (WHIT-266).
  expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
});

it('Sign in again signs out (→ anon, gate redirects to login)', () => {
  renderGate();
  fireEvent.press(screen.getByText('Sign in again'));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});

it('re-locks on a genuine background → active resume', () => {
  mockStatus = 'authed';
  renderGate();
  expect(screen.getByTestId('child')).toBeTruthy();
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(mockUnlock).toHaveBeenCalledTimes(1);
});

it('does NOT re-lock on inactive → active (the Face ID sheet loop guard)', () => {
  mockStatus = 'authed';
  renderGate();
  // The biometric sheet backgrounds the app to 'inactive', not 'background'.
  appStateHandler('inactive');
  appStateHandler('active');
  expect(mockLock).not.toHaveBeenCalled();
  expect(mockUnlock).not.toHaveBeenCalled();
});

it('flag off → no lock screen, renders the app (WHIT-160 preserved)', () => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
  mockStatus = 'authed';
  renderGate();
  expect(screen.queryByText('Whittle is locked')).toBeNull();
  expect(screen.getByTestId('child')).toBeTruthy();
});
