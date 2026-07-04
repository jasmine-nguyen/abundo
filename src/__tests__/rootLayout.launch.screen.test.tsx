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
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

const mockRegister = jest.fn();
jest.mock('../push', () => ({ registerForPushNotificationsAsync: (...a: unknown[]) => mockRegister(...a) }));

// Control font readiness: useAppFonts (native path) reads `[loaded] = useFonts(...)`.
let mockFontsLoaded = false;
jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [mockFontsLoaded],
  Inter_500Medium: 'Inter_500Medium',
  Inter_700Bold: 'Inter_700Bold',
}));
jest.mock('@expo-google-fonts/inter-tight', () => ({ InterTight_800ExtraBold: 'InterTight_800ExtraBold' }));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: () => Promise.resolve(),
  hideAsync: () => Promise.resolve(),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-router', () => {
  const React = require('react');
  const Stack: any = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  Stack.Screen = () => null;
  return { Stack };
});
// AppProvider fires data fetches on mount; stub it to a passthrough so the mount
// stays hermetic and we test only the launch effect.
jest.mock('../context', () => {
  const React = require('react');
  return { AppProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children) };
});
jest.mock('../components/Overlays', () => ({ Overlays: () => null }));

import { Platform } from 'react-native';
import RootLayout from '../../app/_layout';

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as unknown as { OS: string }).OS = 'ios'; // native path → `ready` derived from fonts
  mockFontsLoaded = false;
});

it('fires the launch effect ONCE while fonts are still loading (not gated by ready)', () => {
  // First render: fonts not loaded → RootLayout returns the early placeholder. The
  // effect must still have run (it sits above the early return, `[]` deps).
  const { rerender } = render(<RootLayout />);
  expect(mockRegister).toHaveBeenCalledTimes(1);

  // Fonts finish → real tree renders. The effect must NOT re-fire (`[]`, not `[ready]`).
  mockFontsLoaded = true;
  rerender(<RootLayout />);
  expect(mockRegister).toHaveBeenCalledTimes(1);
});

it('does not re-fire on a re-render with no state change', () => {
  mockFontsLoaded = true; // render the full tree directly
  const { rerender } = render(<RootLayout />);
  rerender(<RootLayout />);
  expect(mockRegister).toHaveBeenCalledTimes(1);
});
