// Global test setup. Mocks native modules that have no JS-only implementation so
// component tests can render without a device/simulator.
/* eslint-disable @typescript-eslint/no-var-requires */

// The date picker is a native view; render a lightweight stand-in that still fires
// onChange, so the pay-cycle sheet can be tested headlessly.
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props) => {
    // Tapping emits a fixed picked date through onValueChange using the real
    // (event, date) signature — the Date is the SECOND arg — so the component's
    // arg-extraction (the crash fix) is genuinely exercised.
    return React.createElement(
      Pressable,
      {
        testID: 'mock-datepicker',
        onPress: () => props.onValueChange && props.onValueChange({ type: 'set' }, new Date(2026, 5, 20)),
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

// expo-font: pretend fonts are always loaded so screens don't block on useFonts.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: jest.fn(),
}));

// Silence the act(...) / animation warnings that RN emits in the test renderer and
// add nothing to signal.
jest.spyOn(console, 'warn').mockImplementation(() => {});
