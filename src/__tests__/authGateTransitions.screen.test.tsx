// WHIT-265 — adversarial GAP tests: the gate's DYNAMIC transitions while a redirect
// cover is up. Complements authGateRedirectLoop.screen.test.tsx (cold-launch loop,
// fail-on-revert) and authGate.screen.test.tsx (static states). Same reactive-router
// harness as the loop suite (useSyncExternalStore segments; Redirect completes
// navigation in an effect), extended with:
//   - a MANUAL completion mode, so the mid-flight state (cover up, redirect not yet
//     landed) is observable and status can flip underneath it,
//   - a live status store (real listener set) so signOut/lock/unlock transitions
//     re-render the gate exactly as production setStatus does,
//   - an AppState spy so the resume re-lock listener can be fired for real.
// gateRedirect stays REAL (jest.requireActual).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React, { useEffect } from 'react';
import { Text, AppState, StyleSheet } from 'react-native';
import { render, screen, act } from '@testing-library/react-native';

// Reactive segments store ("mock" prefix so the jest.mock factories may close over it).
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
// auto = the mocked router lands the navigation in the Redirect's effect (like the
// loop suite); manual = the test lands it itself, so the in-flight window is testable.
let mockAutoComplete = true;
let mockNavState: { key: string } | undefined = { key: 'root' };

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirectSpy(href);
    const ReactActual = require('react') as typeof React;
    ReactActual.useEffect(() => {
      if (mockAutoComplete) mockSegStore.set(mockHrefToSegments(href));
    }, [href]);
    return null;
  },
  useSegments: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSegStore.subscribe, () => mockSegStore.segs);
  },
  useRootNavigationState: () => mockNavState,
}));

// Live status store: getStatus reads a mutable var; mockSetStatus notifies the REAL
// listener set the gate subscribed to — production's setStatus, in miniature.
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockStatusListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => {
  mockStatus = s;
  mockStatusListeners.forEach((l) => l());
};
const mockUnlock = jest.fn(async () => {
  // Defer past a microtask, like the real biometric read: the 'locked' state must
  // actually COMMIT (LockScreen replaces the Stack) before the unlock resolves.
  await Promise.resolve();
  mockSetStatus('authed');
  return true;
});
const mockLock = jest.fn(() => mockSetStatus('locked'));
const mockCanBiometric = jest.fn(() => true);

jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // keep the REAL gateRedirect
    getStatus: () => mockStatus,
    subscribe: (l: () => void) => {
      mockStatusListeners.add(l);
      return () => mockStatusListeners.delete(l);
    },
    unlockOrRestore: jest.fn(async () => {}),
    restoreSession: jest.fn(async () => false),
    canBiometricLock: () => mockCanBiometric(),
    unlock: () => mockUnlock(),
    lock: () => mockLock(),
    signOut: jest.fn(async () => {}),
  };
});

import { AuthGate } from '../AuthGate';

// The device-confirmed Stack model (same as the loop suite), plus a MOUNT COUNTER:
// a fresh mount resets navigation to the index route. `stackMounts` is the direct
// probe for the WHIT-265 mechanism — pre-fix, rendering <Redirect> INSTEAD of the
// children unmounted/remounted this on every redirect.
let stackMounts = 0;
function FakeStack() {
  useEffect(() => {
    stackMounts += 1;
    mockSegStore.set([]);
  }, []);
  return <Text testID="child">stack</Text>;
}

let appStateHandler: (s: string) => void;
let appStateSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockSegStore.segs = [];
  mockSegStore.listeners.clear();
  mockStatusListeners.clear();
  mockAutoComplete = true;
  mockNavState = { key: 'root' };
  mockStatus = 'authed';
  mockCanBiometric.mockReturnValue(true);
  stackMounts = 0;
  appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
    appStateHandler = cb as unknown as (s: string) => void;
    return { remove: jest.fn() } as never;
  });
});
afterEach(() => {
  // Restore ONLY this suite's spy — restoreAllMocks would also undo jest.setup.js's
  // global console silencer for the rest of the file.
  appStateSpy.mockRestore();
});

// [A7] Sign out from a DEEP protected route: the Stack must never remount while the
// login redirect is in flight, and the opaque cover must shield it the whole time.
it('[A7] sign-out from a deep protected route: cover shields, child never remounts, settles on login', () => {
  mockAutoComplete = false; // hold redirects so the in-flight window is observable
  mockStatus = 'authed';
  render(
    <AuthGate>
      <FakeStack />
    </AuthGate>,
  );
  // Launch: the fresh Stack resets to index, authed → redirect queued. Land it, then
  // walk the user deep into the app.
  act(() => mockSegStore.set(['(tabs)', 'budgets'])); // launch redirect lands
  act(() => mockSegStore.set(['(tabs)', 'settings'])); // user navigates deep
  expect(screen.queryByTestId('gate-cover')).toBeNull(); // settled, no cover
  mockRedirectSpy.mockClear();
  const mountsBefore = stackMounts;

  // The sign-out broadcast ('anon') arrives while the user sits on /settings.
  act(() => mockSetStatus('anon'));

  // In flight: exactly one redirect to login; the protected Stack is still mounted
  // BEHIND the cover (no remount = no navigation reset = no loop, and no flash).
  expect(mockRedirectSpy).toHaveBeenCalledTimes(1);
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('child')).toBeTruthy();
  const cover = screen.getByTestId('gate-cover');
  // Effective pointerEvents ('auto') is load-bearing: 'none'/'box-none' — via the
  // prop OR the style form — would let a signed-out user's taps land on the
  // protected screen underneath the cover.
  const coverStyle = StyleSheet.flatten(cover.props.style) as { pointerEvents?: string };
  expect(cover.props.pointerEvents ?? coverStyle?.pointerEvents ?? 'auto').toBe('auto');
  expect(stackMounts).toBe(mountsBefore);

  act(() => mockSegStore.set([])); // the router lands on the login screen
  expect(screen.queryByTestId('gate-cover')).toBeNull();
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(stackMounts).toBe(mountsBefore); // never remounted end-to-end
});

// [A8] The target changes VALUE mid-flight: authed→anon while the '/(tabs)/budgets'
// cover is up. A latched/stale target would redirect a signed-out user INTO the app.
it('[A8] authed→anon flip while the into-app redirect is in flight drops the stale redirect', () => {
  mockAutoComplete = false;
  mockStatus = 'authed';
  render(
    <AuthGate>
      <FakeStack />
    </AuthGate>,
  );
  // In flight: authed on index → redirect into the app is up (not yet landed).
  expect(mockRedirectSpy).toHaveBeenCalledWith('/(tabs)/budgets');
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
  mockRedirectSpy.mockClear();

  act(() => mockSetStatus('anon')); // the session died before the redirect landed

  // anon + index = stay on login: the cover and its stale redirect must vanish, and
  // no further redirect into the app may render for a signed-out user.
  expect(screen.queryByTestId('gate-cover')).toBeNull();
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.getByTestId('child')).toBeTruthy();
});

// [A9] The resume path: background→active fires the gate's re-lock listener
// (lock() → lock cover over the STILL-MOUNTED Stack → unlock() → authed). WHIT-266: the
// Stack is NOT unmounted, so it never remounts (stackMounts stays 1), navigation is never
// reset to index, and unlock therefore fires ZERO redirects — you stay exactly where you
// were (budgets here), no Budgets bounce. This is the direct inverse of the pre-WHIT-266
// unmount-and-remount that this test used to assert.
it('[A9] background→Face-ID resume: app stays mounted under the lock cover, no remount, no Budgets bounce', async () => {
  mockAutoComplete = true;
  mockStatus = 'authed';
  render(
    <AuthGate>
      <FakeStack />
    </AuthGate>,
  );
  // Launch converged: authed on index → landed on budgets, cover gone.
  expect(mockSegStore.segs).toEqual(['(tabs)', 'budgets']);
  expect(screen.queryByTestId('gate-cover')).toBeNull();
  mockRedirectSpy.mockClear();
  expect(stackMounts).toBe(1);

  act(() => {
    appStateHandler('background');
    appStateHandler('active'); // the gate's listener runs lock() then void unlock()
  });
  // Locked: the lock cover is up, but the app stays MOUNTED underneath — the Stack did not
  // unmount, so navigation still sits on budgets.
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Abundo is locked')).toBeTruthy();
  // Mounted but hidden from screen readers while locked.
  expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
  expect(stackMounts).toBe(1); // never unmounted while locked
  expect(mockSegStore.segs).toEqual(['(tabs)', 'budgets']);

  await act(async () => {}); // flush the unlock's resolution → 'authed'

  expect(mockUnlock).toHaveBeenCalledTimes(1);
  // Unlocked and settled: lock cover gone, SAME Stack instance (never remounted), no cover,
  // and crucially NO redirect — you're back on budgets exactly as you left it.
  expect(screen.queryByText('Abundo is locked')).toBeNull();
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull();
  expect(stackMounts).toBe(1); // one launch mount, zero remounts — the whole point of WHIT-266
  expect(mockRedirectSpy).not.toHaveBeenCalled();
});

// [A10] navReady false→true on a LATER render: the mounted-guard must RELEASE — the
// redirect + cover appear as soon as the navigator reports a key. Fails if the
// target were computed once and cached instead of derived live at render.
it('[A10] redirect + cover appear when the navigator becomes ready after mount', () => {
  mockAutoComplete = false;
  mockNavState = undefined; // root navigator not mounted yet
  mockStatus = 'anon';
  mockSegStore.segs = ['(tabs)', 'budgets'];
  // Plain child (no FakeStack): a not-yet-ready navigator can't reset segments.
  const view = render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
  expect(mockRedirectSpy).not.toHaveBeenCalled();
  expect(screen.queryByTestId('gate-cover')).toBeNull();

  mockNavState = { key: 'root' }; // the navigator mounts
  view.rerender(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
  expect(mockRedirectSpy).toHaveBeenCalledWith('/');
  expect(screen.getByTestId('gate-cover')).toBeTruthy();
  expect(screen.getByTestId('child')).toBeTruthy(); // still mounted behind the cover
});

// [A11] StrictMode-style double-invoked effects (dev builds re-run every effect):
// the authed cold launch must still converge — every redirect goes the SAME way
// (any '/' here means the anon direction leaked in / ping-pong started), and the
// gate settles with the child mounted and the cover gone.
it('[A11] StrictMode double effects: authed cold launch converges, no ping-pong', () => {
  mockAutoComplete = true;
  mockStatus = 'authed';
  expect(() =>
    render(
      <React.StrictMode>
        <AuthGate>
          <FakeStack />
        </AuthGate>
      </React.StrictMode>,
    ),
  ).not.toThrow();
  const targets = new Set(mockRedirectSpy.mock.calls.map((c) => c[0]));
  expect(targets).toEqual(new Set(['/(tabs)/budgets']));
  expect(screen.getByTestId('child')).toBeTruthy();
  expect(screen.queryByTestId('gate-cover')).toBeNull();
});
