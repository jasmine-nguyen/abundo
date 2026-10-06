import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  globalThis.crypto = { ...globalThis.crypto, getRandomValues } as unknown as Crypto;
}
