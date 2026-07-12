// WHIT-160 — the AuthGate must actually RE-RENDER when restoreSession resolves. The
// existing authGate.screen.test.tsx stubs subscribe as a no-op and feeds a fixed
// status, so it never exercises the loading -> anon transition driven by the
// subscribe() listener. This test wires a real listener set: mount shows the loading
// placeholder, then restoreSession flips status to 'anon' and notifies -> the gate
// re-renders and (on a protected route) redirects to '/'. Fails if useAuthSession
// stops subscribing or subscribes AFTER restoreSession fires.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

const mockRedirectSpy = jest.fn();
let mockSegments: string[] = [];
const mockNavState: { key: string } = { key: 'root' };

jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => {
    mockRedirectSpy(props.href);
    const React2 = require('react');
    const { Text: T } = require('react-native');
    return React2.createElement(T, { testID: 'redirect' }, props.href);
  },
  useSegments: () => mockSegments,
  useRootNavigationState: () => mockNavState,
}));

// A real listener set so subscribe/notify behave like production; getStatus reads a
// mutable variable; restoreSession flips it to 'anon' and notifies (as the real
// setStatus would after a failed silent refresh).
let mockCurrentStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'loading';
const mockListeners = new Set<() => void>();
// The gate's launch call (WHIT-161: unlockOrRestore, which decides biometric-unlock
// vs normal restore). Here it stands in for the resolved launch → flips to 'anon'
// and notifies, exactly as the real setStatus would after a failed silent refresh.
const mockLaunchSpy = jest.fn(async () => {
  mockCurrentStatus = 'anon';
  mockListeners.forEach((l) => l());
});
jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // keep the REAL gateRedirect
    getStatus: () => mockCurrentStatus,
    subscribe: (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); },
    unlockOrRestore: () => mockLaunchSpy(),
    restoreSession: () => mockLaunchSpy(),
  };
});

import { AuthGate } from '../AuthGate';

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockLaunchSpy.mockClear();
  mockListeners.clear();
  mockCurrentStatus = 'loading';
  mockSegments = ['(tabs)', 'budgets']; // an anon user deep on a protected route
  process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
});

it('transitions loading -> anon via the subscribe listener and then redirects', async () => {
  render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
  // the launch call (unlockOrRestore) ran on mount and drove the re-render.
  expect(mockLaunchSpy).toHaveBeenCalledTimes(1);
  // The redirect only appears if the gate re-rendered off 'loading' via the listener.
  expect(await screen.findByTestId('redirect')).toBeTruthy();
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  // WHIT-265: the child stays mounted behind the opaque cover during the redirect.
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
});
