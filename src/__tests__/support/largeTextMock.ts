// WHIT-743 — stand-in for src/hooks/useLargeText: the real constants, with the large-text switch
// read from `isLarge` on each render. jest.setup.js defaults it off; a suite that needs large text:
//
//   let mockLarge = true;
//   jest.mock('../hooks/useLargeText', () =>
//     require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
import { jest } from '@jest/globals';

export function largeTextMockModule(isLarge: () => boolean) {
  return {
    ...(jest.requireActual('../../hooks/useLargeText') as object),
    useLargeText: isLarge,
  };
}
