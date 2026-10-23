// WHIT-839 — stand-in for react-native-safe-area-context. jest.setup.js uses it with zero insets for
// every screen test; a suite that needs a notch passes its own:
//
//   jest.mock('react-native-safe-area-context', () =>
//     require('./support/safeAreaMock').safeAreaMockModule({ top: 47, bottom: 34 }));
import React from 'react';

type Insets = { top?: number; right?: number; bottom?: number; left?: number };

export function safeAreaMockModule(insets: Insets = {}) {
  const inset = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  // Like the real library, the hook reads the context, so a provider (TwoPane, withInsets) can override it.
  const SafeAreaInsetsContext = React.createContext(inset);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext),
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext,
  };
}

// The unfolded Duo held sideways (ABU-118/119). Different left and right insets so a swap is caught.
export const DUO_SIDEWAYS_INSETS = { left: 44, right: 59 };

// Draws `element` with its own insets over the file's mock — nothing to undo after the test.
export function withInsets(insets: Insets, element: React.ReactElement) {
  const { SafeAreaInsetsContext } = require('react-native-safe-area-context');
  return React.createElement(SafeAreaInsetsContext.Provider, { value: { top: 0, right: 0, bottom: 0, left: 0, ...insets } }, element);
}
