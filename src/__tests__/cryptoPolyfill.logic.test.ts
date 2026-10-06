// WHIT-758: Cognito SRP sign-in needs crypto.getRandomValues, which Hermes lacks. Importing
// src/cryptoPolyfill must give the global crypto expo-crypto's getRandomValues when it's
// missing, and leave a working one alone. expo-crypto is a native module (system boundary),
// so it's mocked here with a known function to compare against.
import { describe, it, expect, jest, afterEach } from '@jest/globals';

const mockGetRandomValues = jest.fn(<T>(array: T) => array);

jest.mock('expo-crypto', () => ({
  getRandomValues: mockGetRandomValues,
  randomUUID: () => 'test-uuid',
}));

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function setGlobalCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

function importPolyfill() {
  jest.isolateModules(() => {
    require('../cryptoPolyfill');
  });
}

afterEach(() => {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    return;
  }
  delete (globalThis as { crypto?: unknown }).crypto;
});

describe('cryptoPolyfill', () => {
  it('gives a missing global crypto the expo-crypto getRandomValues', () => {
    setGlobalCrypto(undefined);

    importPolyfill();

    expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues);
  });

  it('fills in getRandomValues on a crypto object that lacks it', () => {
    setGlobalCrypto({});

    importPolyfill();

    expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues);
  });

  it('leaves an existing working getRandomValues untouched', () => {
    const existingGetRandomValues = jest.fn(<T>(array: T) => array);
    setGlobalCrypto({ getRandomValues: existingGetRandomValues });

    importPolyfill();

    expect(globalThis.crypto.getRandomValues).toBe(existingGetRandomValues);
  });
});
