// WHIT-266 — the lock now keeps the app MOUNTED under an opaque cover (instead of unmounting
// and replacing it), so scroll/form state survives lock→unlock and you land back where you were.
// This suite pins the new invariants that neither authGateLock (lock UI) nor authGateTransitions
// (resume/redirect convergence) fully lock down: (1) the app subtree is never remounted across a
// lock→unlock — the state-preservation guarantee; (2) the lock cover is opaque, absolute-fill, on
// top, and blocks touches; (3) the covered app is hidden from screen readers while locked and
// restored after; (4) the keyboard is dismissed as the cover goes up; (5) no redirect fires on
// unlock (no Budgets bounce). gateRedirect stays REAL; auth is mocked to drive status.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React, { useEffect } from 'react';
import { Text, StyleSheet, Keyboard, AppState } from 'react-native';
import { render, screen, act } from '@testing-library/react-native';
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

// A child that counts its own mounts — the direct probe for "the app is not rebuilt across a
// lock". Pre-WHIT-266 the locked branch returned <LockScreen/> instead of the children, so this
// unmounted (and a later remount would bump the counter).
let childMounts = 0;
function MountCounter() {
  useEffect(() => { childMounts += 1; }, []);
  return <Text testID="child">app</Text>;
}

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockUnlock.mockReset().mockImplementation(async () => { setStatus('authed'); return true; });
  mockLock.mockClear();
  mockListeners.clear();
  mockStatus = 'authed';
  mockSegments = ['(tabs)', 'budgets']; // a deep route — NOT the index
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

describe('WHIT-266 lock cover', () => {
  it('never remounts the app across a lock→unlock (state is preserved)', () => {
    renderGate();
    expect(childMounts).toBe(1); // mounted once on launch

    act(() => setStatus('locked'));
    expect(screen.getByText('Whittle is locked')).toBeTruthy();
    expect(childMounts).toBe(1); // still mounted — the lock covered it, didn't destroy it

    act(() => setStatus('authed'));
    expect(screen.queryByText('Whittle is locked')).toBeNull();
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(childMounts).toBe(1); // SAME instance throughout — never rebuilt (the whole point)
  });

  it('lock cover is opaque, absolute-fill, and painted on top', () => {
    renderGate();
    act(() => setStatus('locked'));
    const cover = StyleSheet.flatten(screen.getByTestId('lock-cover').props.style);
    expect(cover.backgroundColor).toBe(C.bg);
    expect(cover.position).toBe('absolute');
    expect([cover.top, cover.right, cover.bottom, cover.left]).toEqual([0, 0, 0, 0]);
    expect(cover.zIndex).toBe(60); // above the WHIT-265 redirect cover (50)
  });

  it('lock cover blocks touches (effective pointerEvents is auto, not none/box-none)', () => {
    renderGate();
    act(() => setStatus('locked'));
    const cover = screen.getByTestId('lock-cover');
    const coverStyle = StyleSheet.flatten(cover.props.style) as { pointerEvents?: string };
    expect(cover.props.pointerEvents ?? coverStyle?.pointerEvents ?? 'auto').toBe('auto');
  });

  it('hides the covered app from screen readers while locked, and restores it after unlock', () => {
    renderGate();
    act(() => setStatus('locked'));
    // Default (a11y-respecting) query can't see the covered app; it is still in the tree.
    expect(screen.queryByTestId('child')).toBeNull();
    expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
    const wrapper = screen.getByTestId('gate-content', { includeHiddenElements: true });
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
    // Lock cover itself is marked modal so VoiceOver ignores the siblings behind it.
    expect(screen.getByTestId('lock-cover').props.accessibilityViewIsModal).toBe(true);

    act(() => setStatus('authed'));
    const shown = screen.getByTestId('gate-content');
    expect(shown.props.accessibilityElementsHidden).toBe(false);
    expect(shown.props.importantForAccessibility).toBe('auto');
    expect(screen.getByTestId('child')).toBeTruthy(); // visible to a11y again
  });

  it('dismisses the keyboard as the lock cover goes up', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    renderGate();
    dismiss.mockClear(); // ignore any dismiss from the initial (unlocked) render
    act(() => setStatus('locked'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  // Note: the "no Budgets bounce on unlock" guarantee is locked by [A9] in
  // authGateTransitions.screen.test.tsx, whose FakeStack resets navigation on (re)mount and so
  // genuinely distinguishes the mounted-through-lock behaviour from the old unmount-remount.
  // A version here with a plain child can't tell the two apart, so it lives only in [A9].

  it('cold launch is unchanged: authed on the index route still lands on budgets', () => {
    mockSegments = []; // the index route (cold launch, before landing)
    renderGate();
    expect(mockRedirectSpy).toHaveBeenCalledWith('/(tabs)/budgets');
  });
});
