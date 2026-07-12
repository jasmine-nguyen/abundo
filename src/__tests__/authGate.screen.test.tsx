// WHIT-160 — the auth gate component (src/AuthGate.tsx). Drives the state machine
// through expo-router + auth mocks and asserts the redirect decision: the pure
// gateRedirect() is kept REAL (jest.requireActual) so this exercises the actual
// rules, not a stub. getStatus/subscribe/restoreSession are controllable.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { C } from '../theme';

const mockRedirectSpy = jest.fn();
let mockSegments: string[] = [];
let mockNavState: { key: string } | undefined = { key: 'root' };

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

const mockGetStatus = jest.fn<() => 'loading' | 'authed' | 'anon'>(() => 'anon');
jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // keep the REAL gateRedirect
    getStatus: () => mockGetStatus(),
    subscribe: () => () => {},
    restoreSession: jest.fn(async () => false),
  };
});

import { AuthGate } from '../AuthGate';

function renderGate() {
  return render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
}

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockSegments = [];
  mockNavState = { key: 'root' };
  process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED = 'true';
  mockGetStatus.mockReturnValue('anon');
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
});

it('redirects an anon user on a protected route to the login screen', () => {
  mockGetStatus.mockReturnValue('anon');
  mockSegments = ['(tabs)', 'budgets'];
  renderGate();
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  // WHIT-265: the child (the root Stack) stays MOUNTED during the redirect —
  // unmounting it resets navigation and loops the gate. The opaque absolute-fill
  // cover is the privacy shield hiding the protected screen while the redirect lands.
  expect(screen.getByTestId('child')).toBeTruthy();
  const cover = StyleSheet.flatten(screen.getByTestId('gate-cover').props.style);
  expect(cover.backgroundColor).toBe(C.bg);
  expect(cover.position).toBe('absolute');
  expect([cover.top, cover.right, cover.bottom, cover.left]).toEqual([0, 0, 0, 0]);
});

it('redirects an anon user on a ROOT-LEVEL detail route (e.g. /loan) to login', () => {
  // Regression: /loan, /rules, /budget/[id] etc. are root-level protected screens
  // with a non-empty, non-(tabs) first segment. They must NOT be treated as the
  // login page (which would leave them reachable while signed out).
  mockGetStatus.mockReturnValue('anon');
  mockSegments = ['loan'];
  renderGate();
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('child')).toBeTruthy(); // WHIT-265: stays mounted, covered
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
});

it('does NOT bounce an authed user off a root-level detail route (e.g. /loan)', () => {
  mockGetStatus.mockReturnValue('authed');
  mockSegments = ['loan'];
  renderGate();
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull(); // no redirect → no cover
});

it('forwards an authed user off the login screen into the app', () => {
  mockGetStatus.mockReturnValue('authed');
  mockSegments = []; // index/login route
  renderGate();
  expect(mockRedirectSpy).toHaveBeenCalledWith('/(tabs)/budgets');
  expect(screen.getByTestId('child')).toBeTruthy(); // WHIT-265: stays mounted, covered
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
});

it('leaves an anon user on the login screen (no redirect loop)', () => {
  mockGetStatus.mockReturnValue('anon');
  mockSegments = [];
  renderGate();
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull(); // no redirect → no cover
});

it('shows a placeholder (no child, no redirect) while loading', () => {
  mockGetStatus.mockReturnValue('loading');
  mockSegments = ['(tabs)', 'budgets'];
  renderGate();
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.queryByTestId('child')).toBeNull();
});

it('gate is UNCONDITIONAL (WHIT-162): redirects an anon user even with no flag set', () => {
  // The static secret is retired, so login is mandatory — the gate no longer keys
  // off EXPO_PUBLIC_AUTH_GATE_ENABLED. Even with it unset, an anon user on a
  // protected route is sent to login.
  delete process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED;
  mockGetStatus.mockReturnValue('anon');
  mockSegments = ['(tabs)', 'budgets'];
  renderGate();
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('child')).toBeTruthy(); // WHIT-265: stays mounted, covered
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
});

it('does not redirect before the navigator is mounted (mounted guard)', () => {
  mockNavState = undefined; // root nav not ready
  mockGetStatus.mockReturnValue('anon');
  mockSegments = ['(tabs)', 'budgets'];
  renderGate();
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull(); // no redirect → no cover
});
