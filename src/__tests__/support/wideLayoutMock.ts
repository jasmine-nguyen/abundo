// ABU-110 — stand-in for src/hooks/useWideLayout: the real constants, with the wide switch read
// from `isWide` on each render. A suite that needs the wide (two-pane) layout:
//
//   let mockWide = true;
//   jest.mock('../hooks/useWideLayout', () =>
//     require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
import { jest } from '@jest/globals';

export function wideLayoutMockModule(isWide: () => boolean) {
  return {
    ...(jest.requireActual('../../hooks/useWideLayout') as object),
    useWideLayout: isWide,
  };
}
