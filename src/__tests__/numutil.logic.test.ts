// WHIT-256 — the shared money-input helpers. parseAmount is the strict decimal gate every
// form/sheet now routes through (reject blanks / exponents / signs / trailing garbage a paste
// slips past the decimal-pad keyboard); numText seeds an input from a stored number.
import { describe, it, expect } from '@jest/globals';
import { parseAmount, numText } from '../numutil';

describe('parseAmount', () => {
  it('accepts clean decimals (incl. leading-dot and surrounding whitespace)', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('2500')).toBe(2500);
    expect(parseAmount('0.5')).toBe(0.5);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('  12.34  ')).toBeCloseTo(12.34, 10);
  });

  it('rejects blanks, signs, exponents, and trailing garbage as NaN', () => {
    for (const bad of ['', '   ', '80abc', '1e3', '-5', '+5', '.', '1.2.3', 'abc']) {
      expect(Number.isNaN(parseAmount(bad))).toBe(true);
    }
  });

  it('every accepted value is >= 0 (the regex is unsigned)', () => {
    for (const good of ['0', '.01', '999999']) {
      expect(parseAmount(good)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('numText', () => {
  it('null / undefined seed as empty string', () => {
    expect(numText(null)).toBe('');
    expect(numText(undefined)).toBe('');
  });

  it('0 seeds as "0", not empty', () => {
    expect(numText(0)).toBe('0');
  });

  it('a real number seeds as its string form', () => {
    expect(numText(12.5)).toBe('12.5');
    expect(numText(2500)).toBe('2500');
  });
});
