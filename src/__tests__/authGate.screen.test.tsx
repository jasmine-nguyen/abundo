// WHIT-160/161/162/265/266 — the auth gate component (src/AuthGate.tsx). Drives the
// state machine through expo-router + auth mocks and asserts the redirect / lock / resume
// decisions. The pure gateRedirect() is kept REAL (jest.requireActual) so these exercise
// the actual rules, not a stub.
//
// WHIT-459 fold: this survivor absorbs seven sibling auth-gate suites (authGateLock,
// authGateLockCover, authGateLockEdges, authGateRedirectLoop, authGateRelockGrace,
// authGateRestore, authGateTransitions). All eight mocked BOTH `expo-router` and `../auth`
// but with subtly different factory bodies, so the module-scope mocks below are a SUPERSET:
//   - one live, mutable auth store (mockStatus + mockListeners) drives getStatus/subscribe
//     for the whole file; mockGetStatus reads it by default so both the `mockReturnValue`
//     suites (survivor, redirect-loop) and the live-store suites (lock family, transitions,
//     restore) work off the same object;
//   - the expo-router mock branches on `mockReactiveRouter` (static var-segments vs a
//     reactive useSyncExternalStore store), `mockRenderRedirectNode` (Redirect renders a
//     <Text testID="redirect"> vs null), and `mockAutoComplete` (reactive nav landing).
// Each sibling's divergent per-test setup lives in its own child describe below, whose
// beforeEach FULLY re-seeds the shared store (status, listeners, timers, flags) so nothing
// leaks across describes. The top-level beforeEach resets everything to a neutral baseline
// first; each describe then overrides only what it needs.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React, { useEffect } from 'react';
import { StyleSheet, Text, AppState, Keyboard } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { C } from '../theme';

// ---------------------------------------------------------------------------
// expo-router SUPERSET mock
// ---------------------------------------------------------------------------
const mockRedirectSpy = jest.fn();
let mockSegments: string[] = [];
let mockNavState: { key: string } | undefined = { key: 'root' };
// When true, useSegments reads the reactive store below (redirect-loop / transitions) and
// Redirect completes navigation in an effect; when false, useSegments reads mockSegments.
let mockReactiveRouter = false;
// Reactive-only: the mocked Redirect lands the navigation in its own effect (auto), or the
// test lands it itself (manual) so the in-flight window is observable.
let mockAutoComplete = true;
// When true, Redirect renders a <Text testID="redirect"> node (survivor / restore assert on
// it); when false it renders null (everyone else). Inert either way for the mockRedirectSpy
// / gate-cover assertions.
let mockRenderRedirectNode = false;

// Reactive segments store ("mock" prefix so the jest.mock factory may close over it). Shared
// by the redirect-loop and transitions describes; a stable snapshot (reassign + notify only
// on a real change) keeps useSyncExternalStore from looping.
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
const mockHrefToSegments = (href: string) =>
  href === '/' ? [] : href.replace(/^\//, '').split('/');

jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => {
    mockRedirectSpy(props.href);
    const ReactActual = require('react') as typeof React;
    // Reactive suites: model router.replace completing after this commit.
    ReactActual.useEffect(() => {
      if (mockReactiveRouter && mockAutoComplete) mockSegStore.set(mockHrefToSegments(props.href));
    }, [props.href]);
    if (mockRenderRedirectNode) {
      const { Text: T } = require('react-native');
      return ReactActual.createElement(T, { testID: 'redirect' }, props.href);
    }
    return null;
  },
  useSegments: () => {
    if (mockReactiveRouter) {
      const ReactActual = require('react') as typeof React;
      return ReactActual.useSyncExternalStore(mockSegStore.subscribe, () => mockSegStore.segs);
    }
    return mockSegments;
  },
  useRootNavigationState: () => mockNavState,
}));

// ---------------------------------------------------------------------------
// ../auth SUPERSET mock — one live, mutable auth store for the whole file.
// ---------------------------------------------------------------------------
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'anon';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: 'loading' | 'authed' | 'anon' | 'locked') => {
  mockStatus = s;
  mockListeners.forEach((l) => l());
};
// getStatus reads the live store by default (live-store suites), but stays a jest.fn so the
// survivor / redirect-loop suites can drive it with mockReturnValue.
const mockGetStatus = jest.fn<() => 'loading' | 'authed' | 'anon' | 'locked'>(() => mockStatus);
const mockUnlock = jest.fn(async () => { mockSetStatus('authed'); return true; });
const mockLock = jest.fn(() => mockSetStatus('locked'));
const mockUnlockOrRestore = jest.fn(async () => {});
const mockCanBiometric = jest.fn(() => true);
const mockSignOut = jest.fn(async () => mockSetStatus('anon'));
const mockRestoreSession = jest.fn(async () => false);

jest.mock('../auth', () => {
  const actual = jest.requireActual('../auth') as typeof import('../auth');
  return {
    ...actual, // keep the REAL gateRedirect
    getStatus: () => mockGetStatus(),
    subscribe: (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); },
    restoreSession: () => mockRestoreSession(),
    unlockOrRestore: () => mockUnlockOrRestore(),
    canBiometricLock: () => mockCanBiometric(),
    unlock: () => mockUnlock(),
    lock: () => mockLock(),
    signOut: () => mockSignOut(),
  };
});

import { AuthGate, RELOCK_GRACE_MS } from '../AuthGate';

// The device-confirmed Stack model (redirect-loop / transitions): a fresh MOUNT resets
// navigation to the index route and bumps a mount counter — the direct probe for the
// WHIT-265/266 "children stay mounted" mechanism.
let stackMounts = 0;
function FakeStack() {
  useEffect(() => {
    stackMounts += 1;
    mockSegStore.set([]);
  }, []);
  return <Text testID="child">stack</Text>;
}

function renderGate() {
  return render(
    <AuthGate>
      <Text testID="child">app</Text>
    </AuthGate>,
  );
}

// Neutral baseline before every test; each describe's own beforeEach then overrides only
// what it needs. clearMocks:true clears call history but NOT implementations, so this
// re-seeds every mock's implementation to guard against leaks across describes.
beforeEach(() => {
  mockRedirectSpy.mockClear();
  mockListeners.clear();
  mockStatus = 'anon';
  mockGetStatus.mockReset().mockImplementation(() => mockStatus);
  mockUnlock.mockReset().mockImplementation(async () => { mockSetStatus('authed'); return true; });
  mockLock.mockReset().mockImplementation(() => mockSetStatus('locked'));
  mockUnlockOrRestore.mockReset().mockImplementation(async () => {});
  mockCanBiometric.mockReset().mockReturnValue(true);
  mockSignOut.mockReset().mockImplementation(async () => mockSetStatus('anon'));
  mockRestoreSession.mockReset().mockImplementation(async () => false);
  mockSegments = [];
  mockNavState = { key: 'root' };
  mockReactiveRouter = false;
  mockAutoComplete = true;
  mockRenderRedirectNode = false;
  mockSegStore.segs = [];
  mockSegStore.listeners.clear();
  stackMounts = 0;
});

// ===== WHIT-160/162 static states (survivor) =====
describe('WHIT-160 auth gate — static redirect states', () => {
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
});

// ===== WHIT-161 (folded from authGateLock.screen.test.tsx) =====
// The AuthGate biometric lock behaviour. gateRedirect stays REAL; the auth session functions
// are driven off the shared live store so we can flip status. AppState is spied so we can fire
// resume transitions. Segments are static ['(tabs)', 'budgets'] for this suite.
describe('WHIT-161 auth gate — biometric lock', () => {
  let appStateHandler: (s: string) => void;

  beforeEach(() => {
    mockRedirectSpy.mockClear();
    mockUnlock.mockReset().mockImplementation(async () => { mockSetStatus('authed'); return true; });
    mockLock.mockClear();
    mockUnlockOrRestore.mockClear();
    mockSignOut.mockClear();
    mockCanBiometric.mockReturnValue(true);
    mockListeners.clear();
    mockStatus = 'locked';
    mockSegments = ['(tabs)', 'budgets'];
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
    expect(screen.getByText('Abundo is locked')).toBeTruthy();
    expect(screen.getByTestId('lock-cover')).toBeTruthy();
    // The app stays MOUNTED (so scroll/form state survives unlock) but is hidden from screen
    // readers while locked: the default a11y-respecting query can't see it; includeHiddenElements
    // reveals it's still in the tree.
    expect(screen.queryByTestId('child')).toBeNull();
    expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
  });

  it('shows the Abundo logo above the lock title', () => {
    renderGate();
    expect(screen.getByTestId('lock-logo', { includeHiddenElements: true })).toBeTruthy();
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
    expect(screen.getByText('Abundo is locked')).toBeTruthy();
    // Still locked → app stays mounted under the cover, hidden from screen readers (WHIT-266).
    expect(screen.getByTestId('child', { includeHiddenElements: true })).toBeTruthy();
  });

  it('Sign in again signs out (→ anon, gate redirects to login)', () => {
    renderGate();
    fireEvent.press(screen.getByText('Sign in again'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('re-locks on a background → active resume after the grace window', () => {
    mockStatus = 'authed';
    const nowSpy = jest.spyOn(Date, 'now');
    renderGate();
    expect(screen.getByTestId('child')).toBeTruthy();
    // Away long enough (past RELOCK_GRACE_MS) → re-prompt Face ID on return.
    nowSpy.mockReturnValueOnce(1_000_000)                        // stamp on background
      .mockReturnValueOnce(1_000_000 + RELOCK_GRACE_MS + 1);     // read on resume
    appStateHandler('background');
    appStateHandler('active');
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockUnlock).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-lock on a brief switch-away (within the grace window)', () => {
    mockStatus = 'authed';
    const nowSpy = jest.spyOn(Date, 'now');
    renderGate();
    // Back after 5s — a quick flick to another app must resume straight in, no Face ID.
    nowSpy.mockReturnValueOnce(1_000_000).mockReturnValueOnce(1_000_000 + 5_000);
    appStateHandler('background');
    appStateHandler('active');
    expect(mockLock).not.toHaveBeenCalled();
    expect(mockUnlock).not.toHaveBeenCalled();
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
    expect(screen.queryByText('Abundo is locked')).toBeNull();
    expect(screen.getByTestId('child')).toBeTruthy();
  });
});

// ===== WHIT-266 (folded from authGateLockCover.screen.test.tsx) =====
// The lock keeps the app MOUNTED under an opaque cover (instead of unmounting and replacing
// it), so scroll/form state survives lock→unlock. gateRedirect stays REAL; auth is driven off
// the shared live store. This suite uses a MountCounter child (to prove no remount) and its
// own renderGate; `setStatus` is a local alias onto the shared store notifier.
describe('WHIT-266 lock cover (folded from authGateLockCover.screen.test.tsx)', () => {
  const setStatus = mockSetStatus;

  // A child that counts its own mounts — the direct probe for "the app is not rebuilt across a
  // lock". Pre-WHIT-266 the locked branch returned <LockScreen/> instead of the children, so this
  // unmounted (and a later remount would bump the counter).
  let childMounts = 0;
  function MountCounter() {
    useEffect(() => { childMounts += 1; }, []);
    return <Text testID="child">app</Text>;
  }

  function renderGate() {
    return render(
      <AuthGate>
        <MountCounter />
      </AuthGate>,
    );
  }

  beforeEach(() => {
    mockRedirectSpy.mockClear();
    mockUnlock.mockReset().mockImplementation(async () => { setStatus('authed'); return true; });
    mockLock.mockClear();
    mockSignOut.mockReset().mockImplementation(async () => setStatus('anon')); // defensive: keeps parity with the folded [G2] setup (clearMocks already zeroes the count)
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

  describe('WHIT-266 lock cover', () => {
    it('never remounts the app across a lock→unlock (state is preserved)', () => {
      renderGate();
      expect(childMounts).toBe(1); // mounted once on launch

      act(() => setStatus('locked'));
      expect(screen.getByText('Abundo is locked')).toBeTruthy();
      expect(childMounts).toBe(1); // still mounted — the lock covered it, didn't destroy it

      act(() => setStatus('authed'));
      expect(screen.queryByText('Abundo is locked')).toBeNull();
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

  // ===== WHIT-266 adversarial gaps (folded in): index-route mutual exclusion, sign-in-again, 3× cycle =====
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
});

// ===== WHIT-161 (folded from authGateLockEdges.screen.test.tsx) =====
// Adversarial GAP tests for AuthGate's resume/lifecycle wiring: the AppState listener is
// REMOVED on unmount; resume re-lock is suppressed when biometrics are unavailable or the
// session isn't authed. gateRedirect stays REAL; the shared live store drives status.
describe('WHIT-161 auth gate — resume/lifecycle edges', () => {
  let appStateHandler: (s: string) => void;
  const removeSpy = jest.fn();

  beforeEach(() => {
    mockUnlock.mockClear();
    mockLock.mockClear();
    mockUnlockOrRestore.mockClear();
    removeSpy.mockClear();
    mockCanBiometric.mockReset().mockReturnValue(true);
    mockListeners.clear();
    mockStatus = 'authed';
    mockSegments = ['(tabs)', 'budgets'];
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
});

// ===== WHIT-265 (folded from authGateRedirectLoop.screen.test.tsx) =====
// The launch-crash redirect loop, reproduced deterministically with a REACTIVE router
// (useSyncExternalStore segments; Redirect completes navigation in an effect; FakeStack resets
// segments to [] on a fresh mount). On the pre-fix AuthGate this loops until React throws
// "Maximum update depth exceeded"; the fixed gate keeps the child mounted behind the cover, so
// the redirect lands exactly once and everything settles.
describe('WHIT-265 auth gate — redirect loop', () => {
  beforeEach(() => {
    mockRedirectSpy.mockClear();
    mockReactiveRouter = true; // useSegments reads mockSegStore; Redirect lands nav in its effect
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
});

// ===== WHIT relock-grace (folded from authGateRelockGrace.screen.test.tsx) =====
// Adversarial GAP tests for the RELOCK_GRACE_MS boundary and the reuse of the SAME AppState
// listener across MULTIPLE background→active cycles. gateRedirect stays REAL; the shared live
// store drives status; each background→active cycle re-stamps and is measured against the grace.
describe('WHIT auth gate — timed re-lock grace', () => {
  let appStateHandler: (s: string) => void;

  beforeEach(() => {
    mockUnlock.mockClear().mockImplementation(async () => { mockSetStatus('authed'); return true; });
    mockLock.mockClear();
    mockUnlockOrRestore.mockClear();
    mockCanBiometric.mockReset().mockReturnValue(true);
    mockListeners.clear();
    mockStatus = 'authed';
    mockSegments = ['(tabs)', 'budgets'];
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
});

// ===== WHIT-160 (folded from authGateRestore.screen.test.tsx) =====
// The AuthGate must actually RE-RENDER when the launch call resolves. Wires a real listener
// set (the shared store): mount shows the loading placeholder, then the launch call
// (unlockOrRestore) flips status to 'anon' and notifies → the gate re-renders and (on a
// protected route) redirects to '/'. mockLaunchSpy stands in for the resolved launch; the
// Redirect renders a <Text testID="redirect"> node for this suite.
describe('WHIT-160 auth gate — restore re-render', () => {
  // The gate's launch call (WHIT-161: unlockOrRestore, which decides biometric-unlock vs normal
  // restore). Here it stands in for the resolved launch → flips to 'anon' and notifies, exactly
  // as the real setStatus would after a failed silent refresh.
  const mockLaunchSpy = jest.fn(async () => {
    mockSetStatus('anon');
  });

  beforeEach(() => {
    mockRedirectSpy.mockClear();
    mockLaunchSpy.mockClear();
    mockListeners.clear();
    mockStatus = 'loading';
    mockSegments = ['(tabs)', 'budgets']; // an anon user deep on a protected route
    mockRenderRedirectNode = true; // this suite asserts findByTestId('redirect')
    mockUnlockOrRestore.mockImplementation(() => mockLaunchSpy());
    // restoreSession is typed Promise<boolean>; the launch spy resolves void (it only flips status),
    // so return a falsy boolean to satisfy the type — the gate ignores the value, it re-renders off
    // the status flip the spy triggers.
    mockRestoreSession.mockImplementation(async () => { await mockLaunchSpy(); return false; });
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
});

// ===== WHIT-265 (folded from authGateTransitions.screen.test.tsx) =====
// Adversarial GAP tests: the gate's DYNAMIC transitions while a redirect cover is up. Same
// reactive-router harness as the redirect-loop suite, extended with a MANUAL completion mode
// (mid-flight state observable) and the shared live status store (signOut/lock/unlock
// transitions re-render the gate as production setStatus does), plus an AppState spy so the
// resume re-lock listener can be fired for real. gateRedirect stays REAL.
describe('WHIT-265 auth gate — dynamic transitions', () => {
  let appStateHandler: (s: string) => void;
  let appStateSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    mockRedirectSpy.mockClear();
    mockReactiveRouter = true;
    mockSegStore.segs = [];
    mockSegStore.listeners.clear();
    mockListeners.clear();
    mockAutoComplete = true;
    mockNavState = { key: 'root' };
    mockStatus = 'authed';
    mockCanBiometric.mockReturnValue(true);
    stackMounts = 0;
    // Deferred unlock, like the real biometric read: the 'locked' state must actually COMMIT
    // before the unlock resolves (re-seeded here so a prior describe's immediate impl can't leak).
    mockUnlock.mockReset().mockImplementation(async () => {
      await Promise.resolve();
      mockSetStatus('authed');
      return true;
    });
    mockLock.mockReset().mockImplementation(() => mockSetStatus('locked'));
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

    // Away past the grace window, so the resume re-locks (WHIT: timed re-lock).
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000_000).mockReturnValueOnce(1_000_000 + RELOCK_GRACE_MS + 1);
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
});
