// WHIT-777 — the shared ../context stand-in: the real module, with useAppContext replaced. Usage:
//   jest.mock('../context', () => require('./support/contextMock').emptyContextMockModule());
//   jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ showToast: mockShowToast })));
// Pass a getter: it runs on every useAppContext call, so values set after the hoisted mock still apply.
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { jest } from '@jest/globals';

export function realContextWith(appContext: () => object) {
  const actual = jest.requireActual('../../context') as typeof import('../../context');
  return { ...actual, useAppContext: appContext };
}

export const emptyContextMockModule = () => realContextWith(() => ({}));
