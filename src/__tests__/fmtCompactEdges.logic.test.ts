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

// WHIT-393 — [A15]-[A16]: the never-overstate rule as a PROPERTY, not a handful of points.
// [A10]-[A12] pin chosen values; a rounding regression at some value nobody happened to pick
// (3_450_000_000 -> "$3.5B") would slip through. These sweep the whole plausible-ceiling domain
// and check the label against the number it was GIVEN. They read the figure back out of the
// label rather than calling fmtCompact again, so they cannot agree with a wrong formatter.
describe('fmtCompact — never names more than it was given', () => {
  // The number a label NAMES. Deliberately avoids float re-multiplication: `1.1 * 1e9` is
  // 1100000000.0000002 in JS, which would manufacture fake "overstatements".
  function dollarsNamed(label: string): number {
    const m = /^\$([\d,]+)(?:\.(\d))?([BM]?)$/.exec(label);
    if (m == null) return Number.NaN; // an unparseable label is itself a failure
    const unit = m[3] === 'B' ? 1_000_000_000 : m[3] === 'M' ? 1_000_000 : 1;
    const tenth = m[2] == null ? 0 : Number(m[2]);
    return Number(m[1].replace(/,/g, '')) * unit + tenth * (unit / 10);
  }

  // Deterministic sweeps (no randomness): every whole million to $2B, every tenth of a
  // million, every tenth of a billion. Covers both units, both sides of each switch, and
  // both the exact and the spelled-out path.
  const PROBES: number[] = [];
  for (let n = 1_000_000; n <= 2_000_000_000; n += 1_000_000) PROBES.push(n);
  for (let n = 1_000_000; n <= 20_000_000; n += 100_000) PROBES.push(n);
  for (let n = 1_000_000_000; n <= 20_000_000_000; n += 100_000_000) PROBES.push(n);
  for (let n = 900_000; n <= 1_100_000; n += 1_000) PROBES.push(n);
  // The last dollars below each unit switch — where a formatter that picks the unit AFTER
  // rounding tips over into "$1000M" / "$1B" for an amount that is neither.
  for (let n = 999_999_000; n <= 999_999_999; n += 1) PROBES.push(n);
  for (let n = 999_990; n <= 999_999; n += 1) PROBES.push(n);

  it('[A15] every label names its input EXACTLY — never rounds up, never rounds down', () => {
    // The harmful direction is naming MORE than the ceiling (the user retypes the figure the
    // message gave them and gets the same message back). Naming less is merely wrong, so both
    // are held to equality.
    const wrong = PROBES.filter((n) => dollarsNamed(fmtCompact(n)) !== n)
      .slice(0, 5)
      .map((n) => `${n} -> ${fmtCompact(n)} (names ${dollarsNamed(fmtCompact(n))})`);
    expect(wrong).toEqual([]);
  });

  it('[A16] an "M" label never reaches 1000M — the billions branch has to win first', () => {
    // "$1000M" is what you get if the unit is chosen after rounding instead of before it.
    // Nonsense to read, and at 999_999_999 it also overstates.
    const nonsense = PROBES.filter((n) => {
      const m = /^\$([\d.]+)M$/.exec(fmtCompact(n));
      return m != null && Number(m[1]) >= 1000;
    }).slice(0, 5).map((n) => `${n} -> ${fmtCompact(n)}`);
    expect(nonsense).toEqual([]);
  });
});
