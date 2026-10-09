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
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: React.createContext(inset),
  };
}
