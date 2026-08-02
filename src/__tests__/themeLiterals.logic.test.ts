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
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'src'];
const EXCLUDE = /(^|[\\/])(__tests__|node_modules)([\\/]|$)/;

// The palettes themselves — colour is their JOB, so a literal here is the source of truth, not a
// copy of one. Everything else must go through C (src/theme.ts) or chartCategoryColor.
const PALETTE_HOMES = new Set(['src/theme.ts', 'src/context.tsx', 'src/chartColors.ts']);

// A quoted rgb()/rgba()/#rrggbb/#rgb. Quoted, because that is what a hand-written colour looks
// like; tint(C.x, a) and other token references are exactly what this is steering people toward.
const RAW_COLOR = /['"`](?:rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b)/g;

// Comments describing a colour are documentation, not shipped colour (src/theme.ts's own token
// comments spell several out). The `[^:]` guard keeps `https://` inside a string from reading as
// a line comment.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (EXCLUDE.test(relative(ROOT, abs))) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry)) out.push(abs);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  return out.sort();
}

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
  'src/icons.tsx': 2,
  'src/motion/ScrollChromeHeader.tsx': 1,
};

const counts = new Map<string, number>();
for (const abs of shippedFiles()) {
  const key = relative(ROOT, abs).split(sep).join('/');
  if (PALETTE_HOMES.has(key)) continue;
  const found = code(readFileSync(abs, 'utf8')).match(RAW_COLOR)?.length ?? 0;
  if (found) counts.set(key, found);
}

describe('hand-written colours can only decrease', () => {
  it('the scan reaches real files and the detector detects (guards a vacuous pass)', () => {
    expect(counts.size).toBeGreaterThan(20);
    // the detector is real
    expect("backgroundColor: '#7c8cff'".match(RAW_COLOR)).toHaveLength(1);
    expect("borderColor: 'rgba(1,2,3,.5)'".match(RAW_COLOR)).toHaveLength(1);
    expect('backgroundColor: tint(C.accentAlt, 0.1)'.match(RAW_COLOR)).toBeNull();
    // comments are stripped, code is not
    expect(code("const a = 1; // '#abcdef'").match(RAW_COLOR)).toBeNull();
    expect(code("const u = 'https://x'; const c = '#abcdef';").match(RAW_COLOR)).toHaveLength(1);
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
