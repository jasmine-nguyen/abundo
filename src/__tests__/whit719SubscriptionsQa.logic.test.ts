// WHIT-719 slice 2 QA — the Subscriptions samples (and the Rules screen's coffee) have one home
// whatever order their keys are written in, the groceries rows sat beside them in the same lists are
// shared too, and no test can change the shared samples.
import { describe, it, expect } from '@jest/globals';
import { COFFEE_RECORD, GROCERIES, GROCERIES_TOP_RECORD, SUBSCRIPTIONS, SUBSCRIPTIONS_RECORD } from './support/categories';
import { findOffenders } from './support/sourceScan';
import { isCopyOf } from './support/inlineRecords';

const SELF = 'whit719SubscriptionsQa.logic.test.ts';
const ALLOWED = new Set(['support/categories.ts', 'whit719SubscriptionsOneHome.logic.test.ts', SELF]);

const offendersOf = (sample: Record<string, unknown>) => findOffenders(isCopyOf(sample), ALLOWED);

// The plain groceries row the add-rule tests list next to Subscriptions: the top-level row without `parent`.
const { parent: _parent, ...GROCERIES_PLAIN } = GROCERIES_TOP_RECORD;

describe('WHIT-719 QA: the Subscriptions samples have one home, in any key order', () => {
  // [A1] plain Subscriptions (the add-rule tests' sample)
  it('[A1] no test file spells out SUBSCRIPTIONS_RECORD, whatever the key order', () => {
    expect(offendersOf(SUBSCRIPTIONS_RECORD)).toEqual([]);
  });

  // [A2] Subscriptions with its colour (Rules screen, writers, fake-server gaps)
  it('[A2] no test file spells out SUBSCRIPTIONS, whatever the key order', () => {
    expect(offendersOf(SUBSCRIPTIONS)).toEqual([]);
  });

  // [A3] the coloured one with recent: 0 (sheetHostMotion, overlaysRealData) is a spread now
  it('[A3] no test file spells out Subscriptions with colour and recent: 0', () => {
    expect(offendersOf({ ...SUBSCRIPTIONS, recent: 0 })).toEqual([]);
  });

  // [A4] the Rules screen coffee is COFFEE_RECORD plus a lower-case colour
  it('[A4] no test file spells out the Rules screen coffee, whatever the key order', () => {
    expect(offendersOf({ ...COFFEE_RECORD, color: '#e8a87c' })).toEqual([]);
  });
});

describe('WHIT-719 QA: the groceries rows in the same category lists are shared too', () => {
  // [A5] the add-rule CATS lists pair SUBSCRIPTIONS_RECORD with the same plain groceries row in 6 files
  it('[A5] no test file spells out the plain groceries row', () => {
    expect(offendersOf(GROCERIES_PLAIN)).toEqual([]);
  });

  // [A6] sheetHostMotion and overlaysRealData pair Subscriptions with the same coloured groceries at recent: 0
  it('[A6] no test file spells out groceries with colour and recent: 0', () => {
    expect(offendersOf({ ...GROCERIES, recent: 0 })).toEqual([]);
  });
});

describe('WHIT-719 QA: the shared Subscriptions samples cannot be changed by a test', () => {
  // [A7] a test that writes to the shared sample can't change it for the next test
  it('[A7] writing to a shared Subscriptions sample leaves it unchanged', () => {
    try { (SUBSCRIPTIONS as { color: string }).color = '#000'; } catch { /* strict mode refuses the write */ }
    try { (SUBSCRIPTIONS_RECORD as { name: string }).name = 'Subs'; } catch { /* same */ }
    expect(SUBSCRIPTIONS.color).toBe('#f0b27a');
    expect(SUBSCRIPTIONS_RECORD.name).toBe('Subscriptions');
  });

  // [A8] the coloured sample is the plain record plus only its colour, so the two can't drift apart
  it('[A8] SUBSCRIPTIONS is SUBSCRIPTIONS_RECORD plus a colour and nothing else', () => {
    const { color, ...rest } = SUBSCRIPTIONS;
    expect(rest).toEqual(SUBSCRIPTIONS_RECORD);
    expect(color).toBe('#f0b27a');
  });
});
