// WHIT-161 — adversarial GAP tests for AuthGate's resume/lifecycle wiring.
// Complements authGateLock.screen.test.tsx (lock screen + resume happy path).
// Covers:
//   - the AppState listener is REMOVED on unmount (no leak / double-fire)
//   - resume re-lock is SUPPRESSED when the device can't biometric-lock (never lock out)
//   - resume re-lock is SUPPRESSED when the session isn't 'authed' (nothing to re-seal)
// gateRedirect stays REAL; the auth session fns are mocked so we drive status/capability.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text, AppState } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  Redirect: () => null,
  useSegments: () => ['(tabs)', 'budgets'],
  useRootNavigationState: () => ({ key: 'root' }),
}));

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockUnlock = jest.fn(async () => { mockStatus = 'authed'; mockListeners.forEach((l) => l()); return true; });
const mockLock = jest.fn(() => { mockStatus = 'locked'; mockListeners.forEach((l) => l()); });
const mockUnlockOrRestore = jest.fn(async () => {});
const mockCanBiometric = jest.fn(() => true);

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
    signOut: jest.fn(async () => {}),
  };
});

import { AuthGate } from '../AuthGate';

let appStateHandler: (s: string) => void;
const removeSpy = jest.fn();

function renderGate() {
  return render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
}

beforeEach(() => {
  mockUnlock.mockClear();
  mockLock.mockClear();
  mockUnlockOrRestore.mockClear();
  removeSpy.mockClear();
  mockCanBiometric.mockReset().mockReturnValue(true);
  mockListeners.clear();
  mockStatus = 'authed';
  process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED = 'true';
  process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
    appStateHandler = cb as unknown as (s: string) => void;
    return { remove: removeSpy } as never;
  });
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
  jest.restoreAllMocks();
});

it('removes the AppState listener on unmount (no leak / double-fire after teardown)', () => {
  const view = renderGate();
  expect(screen.getByTestId('child')).toBeTruthy();
  view.unmount();
  expect(removeSpy).toHaveBeenCalledTimes(1);
});

it('does NOT re-lock on background → active when the device cannot biometric-lock (never lock out)', () => {
  mockCanBiometric.mockReturnValue(false);
  renderGate();
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).not.toHaveBeenCalled();
  expect(mockUnlock).not.toHaveBeenCalled();
});

it('does NOT re-lock on background → active when the session is not authed (nothing to re-seal)', () => {
  mockStatus = 'anon';
  renderGate();
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).not.toHaveBeenCalled();
  expect(mockUnlock).not.toHaveBeenCalled();
});
