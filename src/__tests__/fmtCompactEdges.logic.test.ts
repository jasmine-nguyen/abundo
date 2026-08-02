// WHIT-393 — [A10]-[A14] gap coverage for fmtCompact (src/theme.ts).
// The implementer's describe('fmtCompact') in format.logic.test.ts locks the headline labels
// ($1B / $1.5B / $500M / the fmt fallback). These add what it skips: the exact points where the
// unit switches, the one-decimal rounding INSIDE a unit, and the large-value domain where a
// naive template would leak exponent notation into user-facing copy.
//
// NOTE on [A10]-[A12]: fmtCompact never rounds. It abbreviates only when one decimal names the
// figure EXACTLY, and spells it out in full otherwise — because it labels a LIMIT, and a label
// that overstates tells the user to type an amount the limit then rejects.
// loanCeilingCopy.screen.test.tsx is the test that says WHY that rule exists.
import { describe, it, expect } from '@jest/globals';
import { fmtCompact } from '../theme';

describe('fmtCompact — unit-switch boundaries', () => {
  it('[A10] uses "M" from exactly 1,000,000, never below it', () => {
    expect(fmtCompact(949_999)).toBe('$949,999');
    expect(fmtCompact(950_000)).toBe('$950,000');
    expect(fmtCompact(999_999)).toBe('$999,999');
    expect(fmtCompact(1_000_000)).toBe('$1M');
  });

  it('[A11] uses "B" from exactly 1,000,000,000, never below it', () => {
    expect(fmtCompact(949_999_999)).toBe('$949,999,999');
    expect(fmtCompact(950_000_000)).toBe('$950M');
    expect(fmtCompact(999_999_999)).toBe('$999,999,999');
    expect(fmtCompact(1_000_000_000)).toBe('$1B');
  });
});

describe('fmtCompact — one decimal, exact only', () => {
  it('[A12] abbreviates an exact tenth and spells out everything else', () => {
    expect(fmtCompact(1_100_000_000)).toBe('$1.1B');            // exact tenth
    expect(fmtCompact(1_234_567_890)).toBe('$1,234,567,890');   // would need more decimals
    expect(fmtCompact(1_050_000_000)).toBe('$1,050,000,000');   // two decimals -> not abbreviated
    expect(fmtCompact(1_049_999_999)).toBe('$1,049,999,999');
    expect(fmtCompact(1_234_567)).toBe('$1,234,567');
    expect(fmtCompact(1_200_000)).toBe('$1.2M');                // exact tenth of a million
  });

  it('[A13] below a million it falls back to fmt, which is whole-dollar', () => {
    expect(fmtCompact(949_999.4)).toBe('$949,999');
    expect(fmtCompact(0.5)).toBe('$1');
    expect(fmtCompact(0.4)).toBe('$0');
  });
});

describe('fmtCompact — large-value domain', () => {
  // A money label must never leak "1e+21" / "NaN" / "Infinity" into user-facing copy. Every
  // value a caller could reasonably hold (up to the largest exact integer JS has) must render
  // as a plain money token. Fails loudly if the formatter ever hands a template a value
  // String() renders in exponent form.
  const MONEY_TOKEN = /^\$[\d,]+(\.\d+)?[BM]?$/;

  it.each([
    0,
    1,
    999_999,
    1_000_000,
    1_000_000_000,
    1_000_000_000_000,
    Number.MAX_SAFE_INTEGER,
  ])('[A14] %p renders as a plain money token (no exponent notation)', (n) => {
    expect(fmtCompact(n as number)).toMatch(MONEY_TOKEN);
  });
});
