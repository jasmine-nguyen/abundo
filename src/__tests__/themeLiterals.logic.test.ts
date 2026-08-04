/// <reference types="node" />
// WHIT-398 — a RATCHET on hand-written colours, generalised from the chip-blue scan.
//
// accentAltSweep.logic.test.ts proves ONE colour is written once, as a token. The same machinery
// answers the general question, and the answer is that 168 raw colours are still hand-typed across
// 27 shipped files — each one the same 52-copies-of-one-blue problem waiting to happen.
//
// Sweeping all 168 would dwarf the change under review, so this locks the direction instead of the
// destination: a per-file BASELINE that can only go DOWN. Add a raw colour to a file and it reddens
// with the file named. Remove some and it reddens too — telling you to lower the number, which is
// how the list gets burned down. It cannot be satisfied by adding an exemption, only by using a
// token or by editing a number you have to look at.
//
// This is a REGRESSION backstop, not a quality signal. It says "no new hand-written colours",
// nothing about whether the existing ones are right.
import { describe, it, expect } from '@jest/globals';
import { RAW_COLOR_SOURCE, shippedCode, stripComments } from './support/sourceScan';

// src/theme.ts, src/categoryColors.ts and src/chartColors.ts are pure palettes — colour is their
// JOB, so a literal there is the source of truth, not a copy of one.
//
// src/categoryColors.ts holds the app-wide category palette (BUCKET_COLOR / PALETTE / CATEGORY_BASE
// / CATEGORY_SIBLINGS), moved out of src/context.tsx by WHIT-422. That move ended context.tsx's
// wholesale exemption: it is now scanned like any other file, at an honest baseline of its residual
// UI colours (the seven copies of '#cfd2ff' folded into C.textInfo at the same time).
const PALETTE_HOMES = new Set(['src/theme.ts', 'src/categoryColors.ts', 'src/chartColors.ts']);

const RAW_COLOR = new RegExp(RAW_COLOR_SOURCE, 'g');

// Baseline as of WHIT-398. Lower a number when you tokenise a file; delete the key at zero.
// Never raise one — that is the regression this exists to stop.
const BASELINE: Record<string, number> = {
  'app/(tabs)/budgets.tsx': 10,
  'app/(tabs)/goals.tsx': 3,
  'app/(tabs)/insights.tsx': 3,
  'app/(tabs)/settings.tsx': 5,
  'app/(tabs)/transactions.tsx': 14,
  'app/budget/[id].tsx': 4,
  'app/budget/edit.tsx': 4,
  'app/budget/pick.tsx': 3,
  'app/category/edit.tsx': 4,
  'app/goal/edit.tsx': 4,
  'app/index.tsx': 29,
  'app/milestone.tsx': 13,
  'app/milestone/edit.tsx': 1,
  'app/mortgage.tsx': 14,
  'app/rules.tsx': 6,
  'app/transaction/[id].tsx': 1,
  'src/AuthGate.tsx': 1,
  'src/components/CategoryFields.tsx': 8,
  'src/components/EarnedVsSpent.tsx': 1,
  'src/components/Header.tsx': 3,
  'src/components/Overlays.tsx': 20,
  'src/components/PayoffSummary.tsx': 5,
  'src/components/QuickCreateCategory.tsx': 3,
  'src/components/TransactionRow.tsx': 3,
  'src/components/ui.tsx': 3,
  'src/context.tsx': 5,
  'src/icons.tsx': 2,
  'src/motion/ScrollChromeHeader.tsx': 1,
};

const counts = new Map<string, number>();
for (const [file, src] of shippedCode()) {
  if (PALETTE_HOMES.has(file)) continue;
  const found = src.match(RAW_COLOR)?.length ?? 0;
  if (found) counts.set(file, found);
}

describe('hand-written colours can only decrease', () => {
  it('the scan reaches real files and the detector detects (guards a vacuous pass)', () => {
    expect(counts.size).toBeGreaterThan(20);
    // the detector is real
    expect("backgroundColor: '#7c8cff'".match(RAW_COLOR)).toHaveLength(1);
    expect("borderColor: 'rgba(1,2,3,.5)'".match(RAW_COLOR)).toHaveLength(1);
    expect('backgroundColor: tint(C.accentAlt, 0.1)'.match(RAW_COLOR)).toBeNull();
    // every hex length RN accepts — an 8-digit hex is what design tools export, and a {6}-only
    // pattern can neither match nor backtrack out of one, so it would slip through silently
    expect("backgroundColor: '#7c8cffcc'".match(RAW_COLOR)).toHaveLength(1);
    expect("backgroundColor: '#abcd'".match(RAW_COLOR)).toHaveLength(1);
    expect("backgroundColor: '#abc'".match(RAW_COLOR)).toHaveLength(1);
    // comments are stripped, code is not
    expect(stripComments("const a = 1; // '#abcdef'").match(RAW_COLOR)).toBeNull();
    expect(stripComments("const u = 'https://x'; const c = '#abcdef';").match(RAW_COLOR)).toHaveLength(1);
    // and the palette homes really are excluded — theme.ts is full of literals by design
    expect([...counts.keys()]).not.toContain('src/theme.ts');
  });

  it('[R1] no file has MORE hand-written colours than its baseline', () => {
    const regressions = [...counts]
      .filter(([file, n]) => n > (BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} raw colours, baseline ${BASELINE[file] ?? 0} — use a token in src/theme.ts`);
    expect(regressions).toEqual([]);
  });

  it('[R1] the baseline is honest — no stale entries, no file cleaner than its number', () => {
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (counts.get(file) ?? 0) < n)
      .map(([file, n]) => `${file}: baseline says ${n}, actually ${counts.get(file) ?? 0} — lower it (or delete the key at 0)`);
    expect(stale).toEqual([]);
  });
});
