/// <reference types="node" />
// WHIT-398 — [G1][G2][G3][G4] the SWEEP itself, not the token.
//
// The card's acceptance criterion is ZERO VISUAL CHANGE across 52 rewritten call sites in 19
// files. accentAltToken.logic.test.ts pins the token ([Q16]) and its distance from C.accent
// ([Q17]); insightsSegmentedControl.gaps.screen.test.tsx pins ONE of the 52 surfaces ([A10]/[A11]).
// That leaves the sweep's two real risks unguarded:
//
//   1. The blue is used at NINE different written alphas (.07 .1 .10 .14 .16 .22 .25 .32 .4).
//      [Q16] pins only .16 — nothing proved the other eight still render the pre-token colour,
//      and the rewrite deliberately changed the emitted string form (`.16` → `0.16`, `.10` → `0.1`).
//   2. Nothing stops a raw 'rgba(124,140,255,…)' literal being pasted back in tomorrow, which is
//      how the duplication got to 52 copies in the first place.
//
// Same shape as the other structural guard in this suite, themeLayout.logic.test.ts: derive the
// list from the tree rather than hard-coding filenames, so a NEW offender is caught the day it
// appears instead of the day someone remembers to update a list.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { C, tint } from '../theme';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'src'];
// The tests themselves are exempt: insightsSegmentedControl.gaps.screen.test.tsx pins the raw
// literal ON PURPOSE (asserting against tint(C.accentAlt,…) there would pass even if the token
// were repainted), and accentAltToken.logic.test.ts pins the token's rgba output.
const EXCLUDE = /(^|[\\/])(__tests__|node_modules)([\\/]|$)/;

function sourceFiles(): string[] {
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

// Comments are not shipped colour. src/theme.ts spells the old literal out in the token's
// explanatory comment, and that must not read as a violation — but a literal in real CODE in
// theme.ts still must. Strip comments rather than exempting the file.
// The `[^:]` guard keeps `https://…` inside a string from being mistaken for a comment.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const RAW_CHIP_BLUE = /['"`]rgba\(\s*124\s*,\s*140\s*,\s*255\s*[,)]/i;
// After this card the likeliest way to reintroduce the duplication is pasting the token's own
// value out of theme.ts, so the hex form is an offender everywhere except its declaration.
const RAW_CHIP_HEX = /['"`]#7c8cff['"`]/i;
const TOKEN_HOME = join('src', 'theme.ts');
const CHIP_CALL = /tint\(\s*C\.accentAlt\s*,\s*([0-9.]+)\s*\)/g;
const TINT_TOKEN_CALL = /tint\(\s*C\.([A-Za-z0-9_]+)\s*,/g;

const FILES = sourceFiles();
const CODE = new Map(FILES.map((f) => [relative(ROOT, f), code(readFileSync(f, 'utf8'))]));

function matchesAcross(re: RegExp): { file: string; capture: string }[] {
  const hits: { file: string; capture: string }[] = [];
  for (const [file, src] of CODE) {
    for (const m of src.matchAll(new RegExp(re.source, 'g'))) hits.push({ file, capture: m[1] });
  }
  return hits;
}

// ---- [G1] the literal cannot creep back ---------------------------------------------------------
describe('[G1] the chip blue is written once, as a token', () => {
  it('the scan actually reaches the swept files (guards a vacuous pass)', () => {
    const names = [...CODE.keys()];
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain(TOKEN_HOME);
    expect(names).toContain(join('app', '(tabs)', 'budgets.tsx'));
    expect(names).toContain(join('src', 'components', 'TransactionRow.tsx'));
    // Reaching the files is not enough — code() must leave their CODE behind. Without this,
    // a code() that returned '' would make [G1] green forever while still "scanning" 62 files.
    expect(CODE.get(TOKEN_HOME)).toContain("accentAlt: '#7c8cff'");
    expect(code('const a = 1; // rgba(124,140,255,.16)')).not.toMatch(RAW_CHIP_BLUE);
    expect(code("const u = 'https://x'; const c = 'rgba(124,140,255,.16)';")).toMatch(RAW_CHIP_BLUE);
    // and the detectors genuinely detect — a broken regex here would make [G1] green forever
    expect(RAW_CHIP_BLUE.test("backgroundColor: 'rgba(124,140,255,.16)'")).toBe(true);
    expect(RAW_CHIP_BLUE.test('borderColor: "rgba(124, 140, 255, .4)"')).toBe(true);
    expect(RAW_CHIP_BLUE.test('backgroundColor: tint(C.accentAlt, 0.16)')).toBe(false);
    expect(RAW_CHIP_HEX.test("backgroundColor: '#7c8cff'")).toBe(true);
    expect(RAW_CHIP_HEX.test("accentAlt: '#7C8CFF'")).toBe(true);
  });

  it('[G1] no shipped file writes the chip blue as a raw literal — use tint(C.accentAlt, a)', () => {
    const offenders = [...CODE]
      .filter(([file, src]) => RAW_CHIP_BLUE.test(src) || (RAW_CHIP_HEX.test(src) && file !== TOKEN_HOME))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

// ---- [G2] every alpha still renders the exact pre-token colour -----------------------------------
// The nine literal forms this card replaced, read off `git show HEAD~ -- app src` before the sweep.
// `.1` and `.10` are the same colour written two ways; the sweep emits `0.1` for both.
const PRE_TOKEN_LITERALS = [
  'rgba(124,140,255,.07)',
  'rgba(124,140,255,.1)',
  'rgba(124,140,255,.10)',
  'rgba(124,140,255,.14)',
  'rgba(124,140,255,.16)',
  'rgba(124,140,255,.22)',
  'rgba(124,140,255,.25)',
  'rgba(124,140,255,.32)',
  'rgba(124,140,255,.4)',
];

// A colour, not a string. `rgba(124,140,255,.10)` and `rgba(124,140,255,0.1)` are different
// strings and the SAME pixel — comparing the strings would fail the sweep for no reason, and
// comparing tint()'s output to a re-formatted tint() output would prove nothing.
function parseRgba(css: string): { r: number; g: number; b: number; a: number } {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/.exec(css);
  if (!m) throw new Error(`not an rgba() string: ${css}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
}

const PRE_TOKEN_BY_ALPHA = new Map(PRE_TOKEN_LITERALS.map((lit) => [parseRgba(lit).a, parseRgba(lit)]));
const ALPHAS_IN_USE = [...new Set(matchesAcross(CHIP_CALL).map((h) => Number(h.capture)))].sort((a, b) => a - b);

describe('[G2] the sweep was colour-preserving at every alpha', () => {
  it('finds the chip-blue call sites it is meant to be checking', () => {
    // The sweep landed 52 call sites. A floor, not the exact number: this assertion exists only
    // so [G2] can't go green by scanning nothing. Sweep COMPLETENESS is [G1]'s job, and adding
    // another add-button tomorrow is not a reason to redden the suite.
    expect(matchesAcross(CHIP_CALL).length).toBeGreaterThan(40);
    expect(ALPHAS_IN_USE.length).toBeGreaterThan(1);
  });

  it.each(ALPHAS_IN_USE)(
    '[G2] tint(C.accentAlt, %s) renders the identical colour to the pre-token literal it replaced',
    (alpha) => {
      const before = PRE_TOKEN_BY_ALPHA.get(alpha);
      // An alpha with no pre-token entry is a NEW shade of the chip blue invented after the sweep.
      // That is a visual decision, not a refactor — add it to PRE_TOKEN_LITERALS on purpose.
      expect(before).toBeDefined();
      expect(parseRgba(tint(C.accentAlt, alpha))).toEqual(before);
    },
  );

  // Eight distinct alphas (.1 and .10 are the same colour written two ways). 0.32 has a SINGLE
  // call site — app/budget/edit.tsx, a bar in the history chart — so if that surface is
  // legitimately removed, delete its literal from PRE_TOKEN_LITERALS in the same commit.
  // This failing means a shade left the app, not that something was repainted.
  it('[G2] every pre-token shade is still in use — a missing one is a deliberate deletion, not a repaint', () => {
    expect(ALPHAS_IN_USE).toEqual([...PRE_TOKEN_BY_ALPHA.keys()].sort((a, b) => a - b));
  });
});

// ---- [G3] no tint() call site can silently produce rgba(NaN,NaN,NaN,a) --------------------------
describe('[G3] every tint(C.…) call site is handed a #rrggbb token', () => {
  // tint() slices the first six characters after '#'. Hand it one of the tokens that is ALREADY an
  // rgba string (C.hairline, C.hairlineStrong) and it returns the string 'rgba(NaN,NaN,NaN,0.5)' —
  // no throw, no type error, just an invisible element. This card multiplied tint(C.x, a) call
  // sites by 52, so the idiom is now everywhere; this keeps the trap shut.
  const tokens = [...new Set(matchesAcross(TINT_TOKEN_CALL).map((h) => h.capture))].sort();

  it('finds the tokens it is meant to be checking', () => {
    expect(tokens).toContain('accentAlt');
    // Deliberately NOT asserting 'accent' here. WHIT-398 moved AiCoachCard — the last production
    // tint(C.accent, …) call site — onto accentAlt, so that token now reaches tint() only from
    // inside theme.ts. Pinning a second specific name would just go stale the same way.
    expect(tokens.length).toBeGreaterThan(2);
    // and the trap is real, not hypothetical
    // C.hairline is already an rgba() string; tint() slices it as if it were hex and emits
    // 'rgba(NaN,186,NaN,0.5)' — a silently invisible element, no throw, no type error.
    expect(tint(C.hairline, 0.5)).toContain('NaN');
  });

  it.each(tokens)('[G3] C.%s is a #rrggbb hex, so tint() of it is a real colour', (token) => {
    const value = (C as unknown as Record<string, string>)[token];
    expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tint(value, 0.16)).not.toContain('NaN');
  });
});

// ---- [G4] tint() stays an alpha-only function ---------------------------------------------------
describe('[G4] tint() only sets alpha', () => {
  // All 52 swept sites now derive their colour through tint(). If tint() ever became a
  // blend-against-the-background helper, every one of them repaints and [Q16] alone (which pins a
  // single alpha) would be the only thing that noticed.
  it('[G4] passes the rgb through untouched at 0, mid and 1 alpha', () => {
    expect(tint('#7c8cff', 0)).toBe('rgba(124,140,255,0)');
    expect(tint('#7c8cff', 0.5)).toBe('rgba(124,140,255,0.5)');
    expect(tint('#7c8cff', 1)).toBe('rgba(124,140,255,1)');
    expect(tint('#000000', 0.5)).toBe('rgba(0,0,0,0.5)');
    expect(tint('#ffffff', 0.5)).toBe('rgba(255,255,255,0.5)');
  });
});
