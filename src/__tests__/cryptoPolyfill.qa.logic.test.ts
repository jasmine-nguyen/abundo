// WHIT-758 QA: the edges around src/cryptoPolyfill the base suite leaves open — Cognito's own
// random-number helper actually picking the polyfill up, the import staying first in the
// root layout, and a partial crypto object keeping what it already had.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setGlobalCrypto, restoreGlobalCrypto } from './support/globalCrypto';

const SENTINEL = 0xc0ffee;
const mockGetRandomValues = jest.fn(<T>(array: T) => {
  (array as unknown as Uint32Array).fill(SENTINEL);
  return array;
});

jest.mock('expo-crypto', () => ({
  getRandomValues: mockGetRandomValues,
  randomUUID: () => 'test-uuid',
}));

function importPolyfillThen<T>(load: () => T): T {
  let loaded!: T;
  jest.isolateModules(() => {
    require('../cryptoPolyfill');
    loaded = load();
  });
  return loaded;
}

afterEach(restoreGlobalCrypto);

describe('cryptoPolyfill — Cognito sign-in', () => {
  // [A1]
  it("feeds Cognito's secure random int from expo-crypto when the phone has no crypto", () => {
    setGlobalCrypto(undefined);

    const cryptoSecureRandomInt = importPolyfillThen(
      () => require('amazon-cognito-identity-js/lib/utils/cryptoSecureRandomInt').default,
    );

    expect(cryptoSecureRandomInt()).toBe(SENTINEL);
    expect(mockGetRandomValues).toHaveBeenCalledTimes(1);
  });

  // [A2]
  it('works when called detached from the crypto object (as Cognito captures it)', () => {
    setGlobalCrypto(undefined);

    importPolyfillThen(() => undefined);
    const { getRandomValues } = globalThis.crypto;
    const filled = getRandomValues(new Uint32Array(2));

    expect(Array.from(filled)).toEqual([SENTINEL, SENTINEL]);
  });
});

describe('cryptoPolyfill — existing crypto objects', () => {
  // [A3]
  it('keeps the other tools on a crypto object that lacks getRandomValues', () => {
    const randomUUID = () => 'native-uuid';
    setGlobalCrypto({ randomUUID });

    importPolyfillThen(() => undefined);

    expect(globalThis.crypto.randomUUID).toBe(randomUUID);
    expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues);
  });

  // [A4]
  it('leaves a working crypto object itself in place, not a copy', () => {
    const existing = { getRandomValues: (array: Uint32Array) => array };
    setGlobalCrypto(existing);

    importPolyfillThen(() => undefined);

    expect(globalThis.crypto).toBe(existing);
  });

  // [A5]
  it('replaces a getRandomValues that is not a function', () => {
    setGlobalCrypto({ getRandomValues: true });

    importPolyfillThen(() => undefined);

    expect(globalThis.crypto.getRandomValues).toBe(mockGetRandomValues);
  });
});

describe('root layout import order', () => {
  // [A6] Cognito reads crypto once when it loads, so the polyfill must run before anything else.
  it('imports the crypto polyfill before anything else', () => {
    const source = readFileSync(join(__dirname, '../../app/_layout.tsx'), 'utf8');
    const firstImport = source.split('\n').find((line) => /^import\b/.test(line));

    expect(firstImport).toMatch(/^import ['"]\.\.\/src\/cryptoPolyfill['"];?$/);
  });
});
