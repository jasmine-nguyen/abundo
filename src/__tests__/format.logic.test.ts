// Formatting + label helpers: merchantLabel/cleanName (row + sheet share one
// display name), fmt/tint (money + colour tokens), and cycleName (Weekly /
// Fortnightly / Monthly).
import { describe, it, expect } from '@jest/globals';
import { cleanName, merchantLabel, cycleName } from '../context';
import { fmt, fmt2, fmtBalance, fmtExact, tint, agoLabel } from '../theme';
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

describe('fmtExact', () => {
  it('stays whole-dollar when there are no cents', () => {
    expect(fmtExact(80)).toBe('$80');
    expect(fmtExact(0)).toBe('$0');
    expect(fmtExact(1234)).toBe('$1,234');
  });

  it('shows cents (and the true amount) when the total has real cents', () => {
    expect(fmtExact(73.5)).toBe('$73.50');   // the reported bug: 73.5 must NOT round to $74
    expect(fmtExact(12.5)).toBe('$12.50');
    expect(fmtExact(1234.5)).toBe('$1,234.50'); // thousands separator + cents
  });

  it('is unsigned (shows the magnitude, like fmt)', () => {
    expect(fmtExact(-11)).toBe('$11');
    expect(fmtExact(-6.5)).toBe('$6.50');
  });

  it('is stable across floating-point sums that land on a whole/half dollar', () => {
    expect(fmtExact(62.5 + 11)).toBe('$73.50');   // posted + pending
    expect(fmtExact(0.1 + 0.2)).toBe('$0.30');     // classic float error rounds clean
    expect(fmtExact(79.999)).toBe('$80');          // rounds to a whole dollar → no ".00"
    expect(fmtExact(73.499999)).toBe('$73.50');    // rounds up into cents
  });
});

describe('fmt2', () => {
  it('shows sign and two decimals', () => {
    expect(fmt2(-12.5)).toBe('-$12.50');
    expect(fmt2(2500)).toBe('+$2,500.00');
  });
});

describe('fmtBalance', () => {
  it('signs only negatives (colour carries the positive case) with two decimals', () => {
    expect(fmtBalance(96270.59)).toBe('$96,270.59');   // in credit — bare, no + sign
    expect(fmtBalance(-596642.43)).toBe('-$596,642.43'); // owing
    expect(fmtBalance(0)).toBe('$0.00');
  });
});

describe('tint', () => {
  it('converts a hex colour + alpha into an rgba string', () => {
    expect(tint('#E8A87C', 0.15)).toBe('rgba(232,168,124,0.15)');
    expect(tint('#000000', 1)).toBe('rgba(0,0,0,1)');
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
