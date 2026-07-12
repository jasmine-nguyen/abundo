// WHIT-265 — the launch-crash redirect loop, reproduced deterministically. On a real
// device, rendering <Redirect> INSTEAD of the gate's children unmounted the root
// <Stack>; a freshly remounted Stack starts back at the index route (segments []),
// so the gate saw authed+onIndex again and re-redirected — an infinite mount/unmount
// ping-pong that exceeded React's update depth and killed the Release app at launch.
//
// Unlike the other gate suites (static segments), this harness makes the router
// REACTIVE so the device mechanism actually plays out in jest:
//  - useSegments reads a mutable store via useSyncExternalStore (stable snapshot —
//    reassign + notify only on a real change, or the hook itself loops),
//  - the Redirect mock completes its navigation in an effect (segments := target),
//  - the FakeStack child models the device-confirmed reset: a fresh MOUNT sets
//    segments back to [] (a new Stack starts at its initial route, index).
// On the pre-fix AuthGate this loops until React throws "Maximum update depth
// exceeded" inside render(); the fixed gate keeps the child mounted behind the
// cover, so the redirect lands exactly once and everything settles.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React, { useEffect, useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// Reactive segments store ("mock" prefix so the jest.mock factory may close over it).
const mockSegStore = {
  segs: [] as string[],
  listeners: new Set<() => void>(),
  set(next: string[]) {
    if (next.join('/') === this.segs.join('/')) return; // no-op notify would loop the hook
    this.segs = next;
    this.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    mockSegStore.listeners.add(l);
    return () => mockSegStore.listeners.delete(l);
  },
};

const mockRedirectSpy = jest.fn();
const mockHrefToSegments = (href: string) =>
  href === '/' ? [] : href.replace(/^\//, '').split('/');

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirectSpy(href);
    const ReactActual = require('react') as typeof React;
    // Model router.replace completing: after this commit, the router state (and so
    // useSegments) reflects the target route.
    ReactActual.useEffect(() => {
      mockSegStore.set(mockHrefToSegments(href));
    }, [href]);
    return null;
  },
  useSegments: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSegStore.subscribe, () => mockSegStore.segs);
  },
  useRootNavigationState: () => ({ key: 'root' }),
}));

const mockGetStatus = jest.fn<() => 'loading' | 'authed' | 'anon'>(() => 'authed');
jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // keep the REAL gateRedirect
    getStatus: () => mockGetStatus(),
    subscribe: () => () => {},
    unlockOrRestore: jest.fn(async () => {}),
    restoreSession: jest.fn(async () => false),
  };
});

import { AuthGate } from '../AuthGate';

// The device-confirmed reset: a freshly mounted Stack starts at the index route.
function FakeStack() {
  useEffect(() => {
    mockSegStore.set([]);
  }, []);
  return <Text testID="child">stack</Text>;
}

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockSegStore.segs = [];
  mockSegStore.listeners.clear();
});

it('authed cold launch on index: redirects exactly once, never loops (WHIT-265 fail-on-revert)', () => {
  mockGetStatus.mockReturnValue('authed');
  mockSegStore.segs = [];
  // Pre-fix this throws "Maximum update depth exceeded": Redirect replaces the
  // FakeStack → navigation lands on (tabs)/budgets → children remount → the fresh
  // mount resets segments to [] → redirect again, forever.
  expect(() =>
    render(
      <AuthGate>
        <FakeStack />
      </AuthGate>,
    ),
  ).not.toThrow();
  // The load-bearing assertions: one redirect, child still mounted, cover gone.
  expect(mockRedirectSpy).toHaveBeenCalledTimes(1);
  expect(mockRedirectSpy).toHaveBeenCalledWith('/(tabs)/budgets');
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull();
});

it('anon on a protected route: one redirect to login, child stays mounted, settles clean', () => {
  mockGetStatus.mockReturnValue('anon');
  mockSegStore.segs = ['(tabs)', 'settings'];
  expect(() =>
    render(
      <AuthGate>
        <FakeStack />
      </AuthGate>,
    ),
  ).not.toThrow();
  expect(mockRedirectSpy).toHaveBeenCalledTimes(1);
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull();
});
