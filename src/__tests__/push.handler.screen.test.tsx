// WHIT-144 — the foreground notification handler registered at module scope in
// src/push.ts. A push arriving while the app is open is discarded by Expo unless a
// handler is set; this locks that it IS set at launch, with the EXACT
// expo-notifications@56 NotificationBehavior shape (shouldShowBanner/shouldShowList,
// NOT the deprecated shouldShowAlert) and the quiet-but-visible values — so a revert
// of either the shape or a value goes red.
//
// The handler is a module-scope side effect that fires ONCE on import, before any
// beforeEach — so we capture the call immediately after importing and never
// clearAllMocks (that would wipe the recorded call).
import { describe, it, expect, jest } from '@jest/globals';

// The handler fires as a module-scope side effect the instant '../push' is imported,
// and ES imports are hoisted above any `const` — so the mock must own its spy inline
// (a `jest.fn()` in the factory), retrieved from the mocked module AFTER the import,
// rather than referencing an outer const that isn't initialised yet.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  // The token fns aren't exercised on this path, but the module imports them.
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
jest.mock('../api', () => ({ registerDevice: jest.fn() }));

import * as Notifications from 'expo-notifications';
// Platform.OS defaults to 'ios' in the react-native jest env, so the native guard
// passes and the handler registers on import. Capture BOTH the call count and the
// handler arg NOW — jest's global clearMocks wipes the live mock's call log before
// each test, so we snapshot the module-scope side effect at import time.
import '../push';
const mockSetHandler = Notifications.setNotificationHandler as jest.Mock;
const setHandlerCallCount = mockSetHandler.mock.calls.length;
const registeredHandler = mockSetHandler.mock.calls[0]?.[0] as
  | { handleNotification: () => Promise<Record<string, unknown>> }
  | undefined;

describe('foreground notification handler (WHIT-144)', () => {
  it('registers exactly one notification handler at launch', () => {
    expect(setHandlerCallCount).toBe(1);
    expect(registeredHandler).toBeDefined();
    expect(typeof registeredHandler!.handleNotification).toBe('function');
  });

  it('presents a foreground push as quiet-but-visible, in the non-deprecated shape', async () => {
    const behaviour = await registeredHandler!.handleNotification();
    // Banner + notification-centre list, but no sound and no badge.
    expect(behaviour).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    // The deprecated field must NOT be used — on expo-notifications@56 it omits the
    // two required fields and logs a deprecation warning.
    expect(behaviour).not.toHaveProperty('shouldShowAlert');
  });
});
