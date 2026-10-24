// Launch wiring (Client: notification permission + device-token registration).
// The subtle risk: RootLayout returns an early placeholder while fonts load, then
// re-renders the real tree — the push effect must fire EXACTLY ONCE and must NOT
// be gated by font-loading (i.e. the effect sits ABOVE the `if (!ready) return`
// with `[]` deps). To actually prove that, this drives the NATIVE font path so
// `ready` starts false (fonts loading), asserts the effect already fired while the
// placeholder is showing, then flips fonts to loaded and asserts the count stays 1.
// This kills both regressions a web-only test misses: gating the effect on `ready`
// (would fire twice) and moving it below the early return (would fire zero times
// on the first, not-ready render).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

const mockRegister = jest.fn();
const mockRemove = jest.fn();
const mockRotation = jest.fn((..._a: unknown[]) => ({ remove: mockRemove }));
jest.mock('../push', () => ({
  registerForPushNotificationsAsync: (...a: unknown[]) => mockRegister(...a),
  // WHIT-145: the launch effect also installs the rotation listener and removes it on
  // cleanup; stub it so the effect doesn't hit undefined and cleanup stays safe.
  registerPushTokenRotation: (...a: unknown[]) => mockRotation(...a),
}));

// Control font readiness: useAppFonts (native path) reads `[loaded] = useFonts(...)`.
let mockFontsLoaded = false;
jest.mock('@expo-google-fonts/inter', () => require('./support/rootLayoutMock').interFontsMock(() => mockFontsLoaded));
jest.mock('@expo-google-fonts/inter-tight', () => require('./support/rootLayoutMock').interTightFontsMock());
jest.mock('expo-splash-screen', () => require('./support/rootLayoutMock').splashScreenMock());
jest.mock('expo-status-bar', () => require('./support/rootLayoutMock').statusBarMock());
jest.mock('expo-router', () => {
  const React = require('react');
  const Stack: any = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  Stack.Screen = () => null;
  // AuthGate (added WHIT-160) calls these; the gate flag is off in this test, so it
  // just renders children — but the hooks must exist so the layout mounts.
  return {
    Stack,
    Redirect: () => null,
    useSegments: () => [],
    useRootNavigationState: () => ({ key: 'root' }),
  };
});
jest.mock('../context', () => require('./support/rootLayoutMock').appProviderMock());
jest.mock('../components/Overlays', () => require('./support/rootLayoutMock').overlaysMock());
jest.mock('../components/NotificationRouter', () => require('./support/rootLayoutMock').notificationRouterMock());

import { Platform } from 'react-native';
import RootLayout from '../../app/_layout';

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as unknown as { OS: string }).OS = 'ios'; // native path → `ready` derived from fonts
  mockFontsLoaded = false;
});

it('fires the launch effect ONCE while fonts are still loading (not gated by ready)', async () => {
  // First render: fonts not loaded → RootLayout returns the early placeholder. The
  // effect must still have run (it sits above the early return, `[]` deps).
  const { rerender } = await render(<RootLayout />);
  expect(mockRegister).toHaveBeenCalledTimes(1);

  // Fonts finish → real tree renders. The effect must NOT re-fire (`[]`, not `[ready]`).
  mockFontsLoaded = true;
  await rerender(<RootLayout />);
  expect(mockRegister).toHaveBeenCalledTimes(1);
});

it('installs the push-token rotation listener once at launch and removes it on unmount (WHIT-145)', async () => {
  mockFontsLoaded = true;
  const { unmount } = await render(<RootLayout />);
  expect(mockRotation).toHaveBeenCalledTimes(1);
  expect(mockRemove).not.toHaveBeenCalled();
  await unmount();
  expect(mockRemove).toHaveBeenCalledTimes(1); // cleanup removes the additive listener
});
