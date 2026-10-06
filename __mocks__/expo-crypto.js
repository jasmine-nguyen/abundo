// Jest manual mock for expo-crypto, applied AUTOMATICALLY to every suite in both projects
// (node-module manual mocks don't need an explicit jest.mock() call). The real module imports
// the native ExpoCrypto binding via requireNativeModule → react-native, which throws
// "__DEV__ is not defined" under the plain-node `logic` env and has no native binding under
// the `screen` env. Mocking it here mirrors jest.setup.js's mocks of other native Expo/RN
// modules (datetimepicker, safe-area-context). Goal-id minting (context.saveGoal) only needs
// a unique string, so a monotonic counter is deterministic and collision-free within a run.
let counter = 0;
module.exports = {
  randomUUID: () => `test-uuid-${++counter}`,
};
