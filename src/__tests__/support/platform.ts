// Pins Platform.OS for every test in the enclosing describe block, then restores it.
import { beforeEach, afterEach } from '@jest/globals';
import { Platform } from 'react-native';

export function usePlatform(os: typeof Platform.OS) {
  const original = Platform.OS;
  beforeEach(() => { Platform.OS = os; });
  afterEach(() => { Platform.OS = original; });
}
