// Formatting + label helpers: merchantLabel/cleanName (row + sheet share one
// display name), the money formatters, and cycleName (Weekly / Fortnightly / Monthly).
import { describe, it, expect } from '@jest/globals';
import { cleanName, merchantLabel } from '../context';
import { cycleName } from '../payCycle';
import { fmt, fmt2, fmtBalance, fmtExact, fmtSignedExact, MINUS, fmtCompact, agoLabel, breakdownLineStyle, C } from '../theme';
import { txn } from './factory';

describe('cleanName / merchantLabel', () => {
  it('maps known raw merchant strings to friendly names', () => {
    expect(cleanName('DD *DOORDASH HUTIEUGOO')).toBe('DoorDash');
    expect(cleanName('SQ *KKV INTERNATIONAL')).toBe('KKV International');
  });

  it('passes through unknown merchants unchanged', () => {
    expect(cleanName('WOOLWORTHS')).toBe('WOOLWORTHS');
  });

  it('prefers merchant_name, falling back to description', () => {
    expect(merchantLabel(txn({ merchant_name: 'Woolworths', description: 'WOOLWORTHS 123' }))).toBe('Woolworths');
    expect(merchantLabel(txn({ merchant_name: '', description: 'DD *DOORDASH HUTIEUGOO' }))).toBe('DoorDash');
  });
});

describe('fmt', () => {
  it('rounds to whole dollars with a thousands separator', () => {
    expect(fmt(1234.56)).toBe('$1,235');
    expect(fmt(0)).toBe('$0');
    expect(fmt(-50)).toBe('$50'); // absolute value
  });
});

// The loan form's ceiling toasts are built from fmtCompact (WHIT-393), and the loan screen
// suites derive their expected toast from it too — so these literal expectations are what stops
// that from being circular. Change the label style here and those suites go red.
describe('fmtCompact', () => {
  it('abbreviates billions, dropping a trailing .0', () => {
    expect(fmtCompact(1_000_000_000)).toBe('$1B');
    expect(fmtCompact(1_500_000_000)).toBe('$1.5B');
    expect(fmtCompact(2_000_000_000)).toBe('$2B');
  });

  it('abbreviates millions below a billion', () => {
    expect(fmtCompact(500_000_000)).toBe('$500M');
    expect(fmtCompact(1_000_000)).toBe('$1M');
    expect(fmtCompact(2_500_000)).toBe('$2.5M');
  });

  it('spells out in full anything one decimal cannot say exactly, never rounding up', () => {
    // It labels a limit, so overstating would name an amount the limit rejects.
    expect(fmtCompact(999_999_999)).toBe('$999,999,999');
    expect(fmtCompact(1_250_000_000)).toBe('$1,250,000,000');
    expect(fmtCompact(999_999)).toBe('$999,999');
  });

  it('falls back to fmt below a million, and is unsigned like fmt', () => {
    expect(fmtCompact(900_000)).toBe('$900,000');
    expect(fmtCompact(0)).toBe('$0');
    expect(fmtCompact(-1_000_000_000)).toBe('$1B');
  });
});

// WHIT-393 — the never-overstate rule as a PROPERTY, not a handful of points. A rounding regression
// at some value nobody happened to pick (3_450_000_000 -> "$3.5B") would slip past the points above.
// These sweep the plausible-ceiling domain and read the figure back out of the label rather than
// calling fmtCompact again, so they cannot agree with a wrong formatter.
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

  // Deterministic sweeps: every whole million to $2B, every tenth of a million, every tenth of a
  // billion, and the last dollars below each unit switch — where a formatter that picks the unit
  // AFTER rounding tips over into "$1000M" / "$1B" for an amount that is neither.
  const PROBES: number[] = [];
  for (let n = 1_000_000; n <= 2_000_000_000; n += 1_000_000) PROBES.push(n);
  for (let n = 1_000_000; n <= 20_000_000; n += 100_000) PROBES.push(n);
  for (let n = 1_000_000_000; n <= 20_000_000_000; n += 100_000_000) PROBES.push(n);
  for (let n = 900_000; n <= 1_100_000; n += 1_000) PROBES.push(n);
  for (let n = 999_999_000; n <= 999_999_999; n += 1) PROBES.push(n);
  for (let n = 999_990; n <= 999_999; n += 1) PROBES.push(n);

  it('[A15] every label names its input EXACTLY — never rounds up, never rounds down', () => {
    const wrong = PROBES.filter((n) => dollarsNamed(fmtCompact(n)) !== n)
      .slice(0, 5)
      .map((n) => `${n} -> ${fmtCompact(n)} (names ${dollarsNamed(fmtCompact(n))})`);
    expect(wrong).toEqual([]);
  });

  it('[A16] an "M" label never reaches 1000M — the billions branch has to win first', () => {
    const nonsense = PROBES.filter((n) => {
      const m = /^\$([\d.]+)M$/.exec(fmtCompact(n));
      return m != null && Number(m[1]) >= 1000;
    }).slice(0, 5).map((n) => `${n} -> ${fmtCompact(n)}`);
    expect(nonsense).toEqual([]);
  });
});

describe('fmtExact', () => {
  it('shows cents (and the true amount) when the total has real cents', () => {
    expect(fmtExact(73.5)).toBe('$73.50');   // the reported bug: 73.5 must NOT round to $74
    expect(fmtExact(12.5)).toBe('$12.50');
    expect(fmtExact(1234.5)).toBe('$1,234.50'); // thousands separator + cents
  });

  it('is stable across floating-point sums that land on a whole/half dollar', () => {
    expect(fmtExact(62.5 + 11)).toBe('$73.50');   // posted + pending
    expect(fmtExact(0.1 + 0.2)).toBe('$0.30');     // classic float error rounds clean
    expect(fmtExact(79.999)).toBe('$80');          // rounds to a whole dollar → no ".00"
    expect(fmtExact(73.499999)).toBe('$73.50');    // rounds up into cents
  });
});

describe('fmtSignedExact', () => {
  it('adds a real minus only below zero at the cent, keeping cents only when present', () => {
    const rows: [number, string][] = [
      [-351.68, `${MINUS}$351.68`],
      [5785, '$5,785'],
      [-659, `${MINUS}$659`],
      [-1234.5, `${MINUS}$1,234.50`],
      [-12.1, `${MINUS}$12.10`],
      [-1234567.891, `${MINUS}$1,234,567.89`],
      [0, '$0'],
      [-0, '$0'],
      [-0.004, '$0'],
      [-0.006, `${MINUS}$0.01`],   // WHIT-735: the minus appears once it rounds below zero at the cent
      [0.006, '$0.01'],
    ];
    for (const [amount, label] of rows) expect(fmtSignedExact(amount)).toBe(label);
  });
});

describe('fmt2', () => {
  it('shows sign and two decimals', () => {
    expect(fmt2(-12.5)).toBe('-$12.50');
    expect(fmt2(2500)).toBe('+$2,500.00');
    expect(fmt2(0)).toBe('+$0.00');
    expect(fmt2(-1234.5)).toBe('-$1,234.50');
  });
});

describe('fmtBalance', () => {
  it('signs only negatives (colour carries the positive case) with two decimals', () => {
    expect(fmtBalance(96270.59)).toBe('$96,270.59');   // in credit — bare, no + sign
    expect(fmtBalance(-596642.43)).toBe('-$596,642.43'); // owing
    expect(fmtBalance(0)).toBe('$0.00');
  });
});

describe('cycleName', () => {
  it('names the cycle from its length', () => {
    expect(cycleName(7)).toBe('Weekly');
    expect(cycleName(14)).toBe('Fortnightly');
    expect(cycleName(30)).toBe('Monthly');
  });
});

describe('agoLabel', () => {
  const now = Date.parse('2026-07-04T12:00:00Z');
  const at = (mins: number) => new Date(now - mins * 60000).toISOString();

  it('buckets the elapsed time into a short label', () => {
    expect(agoLabel(at(0), now)).toBe('just now');
    expect(agoLabel(at(5), now)).toBe('5m ago');
    expect(agoLabel(at(59), now)).toBe('59m ago');
    expect(agoLabel(at(60), now)).toBe('1h ago');
    expect(agoLabel(at(23 * 60), now)).toBe('23h ago');
    expect(agoLabel(at(24 * 60), now)).toBe('1d ago');
    expect(agoLabel(at(2 * 24 * 60), now)).toBe('2d ago');
  });

  it('returns empty for null/blank/unparseable input (caller hides the stamp)', () => {
    expect(agoLabel(null, now)).toBe('');
    expect(agoLabel('', now)).toBe('');
    expect(agoLabel('not-a-date', now)).toBe('');
  });

  it('clamps a future timestamp (clock skew) to "just now"', () => {
    expect(agoLabel(at(-10), now)).toBe('just now');
  });
});

// WHIT-375: the one shared refund/remainder/normal row convention, used by both the Insights
// list and the Earned/Spent breakdown screen. Locks the rule so it can't drift again (the
// refund line once regressed to a signed "-$30").
describe('breakdownLineStyle', () => {
  it('renders a refund as an UNSIGNED green credit, dimmed name', () => {
    // A refund's spent is negative; fmt drops the sign and the green colour carries "credit".
    expect(breakdownLineStyle({ isRefund: true, spent: -30 })).toEqual({
      amountText: '$30',            // NOT "-$30" — the historical regression this guards
      amountColor: C.good,
      nameColor: C.textDim,
    });
  });

  it('keeps the sign on a NEGATIVE remainder "Other" plug, dimmed', () => {
    // A negative plug MUST show its minus or the expanded rows look like they don't add up.
    expect(breakdownLineStyle({ isRemainder: true, spent: -40 })).toEqual({
      amountText: '-$40',
      amountColor: C.textDim,
      nameColor: C.textDim,
    });
  });

  it('renders a REVERSED income source as a signed "−$150" in a neutral tone, bright name (WHIT-376)', () => {
    // A clawed-back income source is a real, tappable category — it reads as a REDUCTION, so a real
    // minus in the neutral mid tone (not green credit, not red overspend), and a bright name.
    expect(breakdownLineStyle({ isReversed: true, spent: -150 })).toEqual({
      amountText: '-$150',
      amountColor: C.textMid,
      nameColor: C.textBright,
    });
  });
});
