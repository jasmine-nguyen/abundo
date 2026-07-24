// WHIT (timed re-lock grace) — adversarial GAP tests for AuthGate's RELOCK_GRACE_MS
// boundary and the reuse of the SAME AppState listener across MULTIPLE background→active
// cycles. Complements authGateLock.screen.test.tsx (past-grace re-lock + within-grace
// no-lock) and authGateLockEdges.screen.test.tsx (biometric-off / not-authed). Covers:
//   - [AB1] awayMs EXACTLY == RELOCK_GRACE_MS → re-locks (the `>=` boundary; guards a
//           silent regression to `>`).
//   - [AB2] a SECOND background→active cycle re-stamps backgroundedAt — a long first
//           absence then a brief second absence must NOT re-lock (proves the stamp
//           refreshes each cycle and isn't stale from the first).
//   - [AB3] the lock logo carries importantForAccessibility="no" (decorative).
//   - [AB4] a BACKWARD clock jump (negative elapsed) re-locks — fail CLOSED, never open.
// gateRedirect stays REAL; the auth session fns are mocked so we drive status.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
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
function setMockStatus(s: typeof mockStatus) {
  mockStatus = s;
  mockListeners.forEach((l) => l());
}
const mockUnlock = jest.fn(async () => { setMockStatus('authed'); return true; });
const mockLock = jest.fn(() => setMockStatus('locked'));
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

import { AuthGate, RELOCK_GRACE_MS } from '../AuthGate';

let appStateHandler: (s: string) => void;

function renderGate() {
  return render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
}

beforeEach(() => {
  mockUnlock.mockClear().mockImplementation(async () => { setMockStatus('authed'); return true; });
  mockLock.mockClear();
  mockUnlockOrRestore.mockClear();
  mockCanBiometric.mockReset().mockReturnValue(true);
  mockListeners.clear();
  mockStatus = 'authed';
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

// [AB1] elapsed EXACTLY at the grace threshold. The check is `elapsedMs >= RELOCK_GRACE_MS`,
// so exactly-at must re-lock. Existing tests only cover grace+1 (past) and 5s (within),
// which both still pass if `>=` silently became `>`; this pins the boundary.
it('[AB1] re-locks when away EXACTLY RELOCK_GRACE_MS (the >= boundary)', () => {
  mockStatus = 'authed';
  const nowSpy = jest.spyOn(Date, 'now');
  renderGate();
  expect(screen.getByTestId('child')).toBeTruthy();
  nowSpy
    .mockReturnValueOnce(1_000_000)                     // stamp on background
    .mockReturnValueOnce(1_000_000 + RELOCK_GRACE_MS);  // resume: awayMs == RELOCK_GRACE_MS
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(mockUnlock).toHaveBeenCalledTimes(1);
});

// [AB2] SAME listener, two cycles. A long first absence re-locks (then unlock → authed);
// a brief second absence must NOT re-lock. Only possible if `backgroundedAt` is re-stamped
// on the 2nd 'background'. If it were stale at the first stamp, the 2nd resume would read a
// huge awayMs and wrongly re-lock again.
it('[AB2] a brief 2nd absence after a long 1st does NOT re-lock (backgroundedAt re-stamps)', () => {
  mockStatus = 'authed';
  const nowSpy = jest.spyOn(Date, 'now');
  renderGate();
  nowSpy
    .mockReturnValueOnce(1_000_000)                      // cycle 1: stamp on background
    .mockReturnValueOnce(1_000_000 + RELOCK_GRACE_MS + 1) // cycle 1: resume past grace → re-lock
    .mockReturnValueOnce(2_000_000)                      // cycle 2: FRESH stamp on background
    .mockReturnValueOnce(2_000_000 + 5_000);             // cycle 2: resume after 5s → within grace
  // Cycle 1: long away → re-lock, then unlock resolves back to authed.
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(mockStatus).toBe('authed');
  // Cycle 2: brief away → must resume straight in (no 2nd re-lock).
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).toHaveBeenCalledTimes(1); // still just the first cycle's lock
  expect(mockUnlock).toHaveBeenCalledTimes(1);
});

// [AB3] The logo is DECORATIVE: importantForAccessibility="no" is what keeps a screen
// reader from announcing it. The existing logo test only asserts the element EXISTS
// (via includeHiddenElements) — it passes whether or not the decorative prop is present.
// This pins the intent by asserting the prop itself. (RNTL's default query does NOT treat
// importantForAccessibility="no" as hidden, so a visibility assertion can't guard this.)
it('[AB3] the lock logo carries the decorative importantForAccessibility="no"', () => {
  mockStatus = 'locked';
  renderGate();
  const logo = screen.getByTestId('lock-logo');
  expect(logo.props.importantForAccessibility).toBe('no');
});

// [AB4] A BACKWARD wall-clock jump between background and resume yields a NEGATIVE elapsed.
// For a lock, an anomalous clock must fail CLOSED — re-lock, never skip Face ID. Pins the
// `elapsedMs < 0` guard: without it, a negative elapsed reads as < grace and would resume
// straight in (fail open).
it('[AB4] a backward clock jump (negative elapsed) re-locks (fail closed)', () => {
  mockStatus = 'authed';
  const nowSpy = jest.spyOn(Date, 'now');
  renderGate();
  nowSpy
    .mockReturnValueOnce(2_000_000)   // stamp on background
    .mockReturnValueOnce(1_000_000);  // resume EARLIER than the stamp → elapsed = -1_000_000
  appStateHandler('background');
  appStateHandler('active');
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(mockUnlock).toHaveBeenCalledTimes(1);
});
