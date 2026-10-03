// Global test setup. Mocks native modules that have no JS-only implementation so
// component tests can render without a device/simulator.
/* eslint-disable @typescript-eslint/no-var-requires */

// WHIT-433 / WHIT-567: raise the per-test ceiling to 15s for the SCREEN project only.
// This file is the screen project's setupFilesAfterEnv (jest.config.js), so jest.setTimeout here
// scopes the ceiling to screen tests while the fast `logic` project stays at Jest's 5s default.
// A project-level `testTimeout` is silently ignored under Jest 30 (the old jest.config.js home);
// jest.setTimeout in setupFilesAfterEnv is honoured. Drop or lower this and the heavy full-provider
// screen suites red under the sharded coverage run (fail-on-revert; see jestScreenTimeout.logic.test.ts).
jest.setTimeout(15000);

// The date picker is a native view; render a lightweight stand-in that still fires
// onChange, so the pay-cycle sheet can be tested headlessly.
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props) => {
    // Tapping emits a fixed picked date through onChange using the real
    // (event, date) signature — the Date is the SECOND arg — so the component's
    // arg-extraction (the crash fix) is genuinely exercised against the actual API.
    return React.createElement(
      Pressable,
      {
        testID: 'mock-datepicker',
        onPress: () => props.onChange && props.onChange({ type: 'set' }, new Date(2026, 5, 20)),
      },
      React.createElement(Text, null, 'picker'),
    );
  };
  return { __esModule: true, default: MockPicker };
});

// safe-area insets: return zero insets so components that read
// useSafeAreaInsets render without a SafeAreaProvider wrapper.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: React.createContext(inset),
  };
});

// react-native-svg draws the category glyphs. It has no JS-only impl, so render
// its exports as plain Views/no-ops — the tests assert on labels/roles, not paths.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = (props) => React.createElement(View, props, props.children);
  return new Proxy(
    { __esModule: true, default: Passthrough, SvgXml: Passthrough, Svg: Passthrough },
    { get: (target, key) => target[key] ?? Passthrough },
  );
});

// AsyncStorage (the Ask Abundo consent, card 609) is a native module; use the package's own
// in-memory stand-in so the chat provider renders headlessly.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest'));

// expo-font: pretend fonts are always loaded so screens don't block on useFonts.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: jest.fn(),
}));

// expo-haptics (card 610): the chat's send buzz is a native call; no-op it headlessly.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// The Insights CSV export (WHIT-700) writes a file and opens the share menu — both native.
// Stub them so every screen that loads Insights renders headlessly; the export's own screen
// test mocks src/cycleShare directly.
jest.mock('expo-file-system', () => ({
  Paths: { cache: {} },
  File: class {
    uri = 'file:///cache/export.csv';
    create() {}
    write() {}
  },
}));
jest.mock('expo-sharing', () => ({
  shareAsync: jest.fn(async () => undefined),
  isAvailableAsync: jest.fn(async () => true),
}));

// Auth native modules (WHIT-160) have no JS-only impl; stub them so any screen that
// transitively imports src/auth (via app/index or the auth gate) renders headlessly.
// Tests that exercise the auth flow itself mock these per-case with real behaviour.
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  // WHIT-161: biometric-lock API. Default: device can't use biometrics, so screen
  // tests store unguarded and never enter the locked path unless a test opts in.
  canUseBiometricAuthentication: jest.fn(() => false),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(() => 'acme://oauthredirect'),
  exchangeCodeAsync: jest.fn(),
  refreshAsync: jest.fn(),
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    promptAsync = jest.fn(async () => ({ type: 'dismiss' }));
    codeVerifier = 'verifier';
  },
}));

// Silence the act(...) / animation warnings that RN emits in the test renderer and
// add nothing to signal.
jest.spyOn(console, 'warn').mockImplementation(() => {});
