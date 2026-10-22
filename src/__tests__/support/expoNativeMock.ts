// The screen project runs the plain React Native preset, not jest-expo, so expo's native module
// layer (`expo` / `expo-modules-core`) can't load. The real expo-router (renderRouter) only needs
// these few pieces of it headlessly. Usage:
//
//   jest.mock('expo', () => require('./support/expoNativeMock').expoNativeMockModule());
//   jest.mock('expo-modules-core', () => require('./support/expoNativeMock').expoNativeMockModule(), { virtual: true });
import { Platform, View } from 'react-native';

export function expoNativeMockModule() {
  return {
    Platform,
    requireOptionalNativeModule: () => null,
    requireNativeModule: () => ({}),
    requireNativeView: () => View,
    NativeModule: class {},
    CodedError: Error,
    UnavailabilityError: Error,
  };
}
