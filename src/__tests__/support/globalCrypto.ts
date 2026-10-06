// Swap the process-wide `crypto` for a test and put Node's own back afterwards. Node defines
// globalThis.crypto as a getter, so plain assignment can't clear it — redefine the property.
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

export function setGlobalCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

export function restoreGlobalCrypto() {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    return;
  }
  delete (globalThis as { crypto?: unknown }).crypto;
}
