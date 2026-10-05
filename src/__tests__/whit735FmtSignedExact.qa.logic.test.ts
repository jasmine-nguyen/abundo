// WHIT-735 QA — fmtSignedExact at the cent boundary and at large amounts.
import { it, expect } from '@jest/globals';
import { fmtSignedExact, MINUS } from '../theme';

// [A7] (P1) the minus appears exactly when the amount rounds below zero at the cent.
it('[A7] a minus only from −0.006 down; zero and large amounts format cleanly', () => {
  expect(fmtSignedExact(0)).toBe('$0');
  expect(fmtSignedExact(-0)).toBe('$0');
  expect(fmtSignedExact(-0.006)).toBe(`${MINUS}$0.01`);
  expect(fmtSignedExact(0.006)).toBe('$0.01');
  expect(fmtSignedExact(-1234567.891)).toBe(`${MINUS}$1,234,567.89`);
  expect(fmtSignedExact(-12.1)).toBe(`${MINUS}$12.10`);
});
