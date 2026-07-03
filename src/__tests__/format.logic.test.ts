// Formatting + label helpers: merchantLabel/cleanName (row + sheet share one
// display name), fmt/tint (money + colour tokens), and cycleName (Weekly /
// Fortnightly / Monthly).
import { describe, it, expect } from '@jest/globals';
import { cleanName, merchantLabel } from '../context';
import { fmt, fmt2, tint } from '../theme';
import { txn, makeState } from './factory';

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

describe('fmt2', () => {
  it('shows sign and two decimals', () => {
    expect(fmt2(-12.5)).toBe('-$12.50');
    expect(fmt2(2500)).toBe('+$2,500.00');
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
    expect(makeState({ cycleLen: 7 }).cycleName()).toBe('Weekly');
    expect(makeState({ cycleLen: 14 }).cycleName()).toBe('Fortnightly');
    expect(makeState({ cycleLen: 30 }).cycleName()).toBe('Monthly');
  });
});
