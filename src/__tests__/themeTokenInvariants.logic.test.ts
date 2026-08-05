/// <reference types="node" />
// WHIT-460 — the theme/colour TOKEN invariants, one file. Folds five WHIT-398/400 logic suites that
// each pinned a different corner of the same palette:
//   • accentAltToken   — the chip blue's exact value, its distance from C.accent, the derived hairlines
//   • accentAltWashCards — the two accentAlt surface recipes (solid wash vs dashed button), scanned from the tree
//   • accentAltSweep   — [G1]-[G4] the sweep itself: literal-can't-creep-back, colour-preserving at every alpha
//   • themeInkTokens   — [Q22]-[Q24] the ink tokens still equal the background hex they were copied from
//   • themeLiterals    — [R1] the per-file raw-colour ratchet
// All five are pure logic (no jest.mock, no timers, no setup), so they share one file with no interaction.
import { describe, it, expect } from '@jest/globals';
import { join } from 'path';
import { C, tint } from '../theme';
import { RAW_COLOR_SOURCE, shippedCode, styleBlocks, stripComments } from './support/sourceScan';

// ============================================================================================
// accentAltToken — WHIT-398 — C.accentAlt is the app's SECOND blue: add buttons, dashed "new X" rows,
// retry pills, the Insights cycle toggle. It was written out as the raw string 'rgba(124,140,255,...)'
// in 52 places before this card. The whole point of the token is that it is NOT a shade of C.accent, so
// the two things worth pinning are its exact value and its distance from the accent it looks like.
// The same card also made the two hairlines derive from the accent instead of being hand-written
// copies of it — [Q18] is what stops them being pasted back.
// ============================================================================================

describe('the chip blue keeps its exact value', () => {
  // [Q16] VALUE PIN. Every call site now derives its colour from this one hex, so a typo here
  // repaints 52 surfaces at once and no screen test would name the culprit.
  it('[Q16] C.accentAlt is #7c8cff and still renders the pre-token rgba', () => {
    expect(C.accentAlt).toBe('#7c8cff');
    expect(tint(C.accentAlt, 0.16)).toBe('rgba(124,140,255,0.16)');
  });
});

describe('the chip blue is still a different blue from the accent (tripwire)', () => {
  // [Q17] TRIPWIRE, not a design rule. accentAlt sits in the accent* block and reads like a shade
  // of C.accent, but it is a different hue: #7c8cff = rgb(124,140,255) vs #7aa2f7 = rgb(122,162,247).
  // The card exists because "tidying" tint(C.accentAlt, a) into tint(C.accent, a) repaints it a
  // greener blue with nothing to catch it — this is what catches it.
  // This failing is not automatically a bug. It is a prompt to decide, on purpose, whether the app
  // should have two brand blues at all, or whether these two should finally merge.
  it('[Q17] accentAlt and accent do not resolve to the same colour', () => {
    expect(C.accentAlt).not.toBe(C.accent);
    expect(tint(C.accentAlt, 0.16)).not.toBe(tint(C.accent, 0.16));
  });
});

describe('the hairlines are DERIVED from the accent, not copies of it', () => {
  // [Q18] The inverse of [Q17], and the other half of WHIT-398. Unlike accentAlt, both hairlines
  // genuinely ARE the accent — but until this card they were hand-typed rgba strings, so repainting
  // C.accent would have left every card border in the app on the old blue with nothing to notice.
  // What this locks: the hairlines and C.accent can never DIVERGE. It does NOT detect a literal
  // pasted back in tint()'s own output format — that only reddens the moment someone repaints
  // C.accent, which is the moment it becomes a visible bug. The two value pins below are the
  // other half: an intentional repaint has to be declared here.
  it('[Q18] hairline and hairlineStrong are exactly the accent at 10% and 16%', () => {
    expect(C.hairline).toBe(tint(C.accent, 0.1));
    expect(C.hairlineStrong).toBe(tint(C.accent, 0.16));
    // and the values themselves are unchanged from the literals they replaced
    expect(C.hairline).toBe('rgba(122,162,247,0.1)');
    expect(C.hairlineStrong).toBe('rgba(122,162,247,0.16)');
  });
});

// ============================================================================================
// accentAltWashCards — WHIT-398 / WHIT-423 — the accentAlt bg+border surfaces are two looks, so they
// must be two recipes.
//
// A wash surface is a soft translucent blue panel with a matching hairline border: the AI coach
// card on Insights, the contribution card on Mortgage, the next-milestone card on Milestone, the
// "use the recommended amount" row on budget edit, and the selection hint banner on Transactions.
// Different shapes, one material — they are meant to read as the same kind of surface. The "add a
// new item" buttons wear a second, related look: the same blue, dashed, at a fainter fill and a
// stronger outline. Both families use tint(C.accentAlt, …) for BOTH fill and border.
//
// They had already drifted: AiCoachCard was built from C.accent at 0.07 fill while the rest used
// the second blue at 0.1 — a slightly greener, fainter panel. Nothing caught it, because each
// screen's stylesheet is module-private and no test rendered two of them together.
//
// WHIT-423: the surfaces are no longer a hand-typed list. We scan the whole tree, find every style
// block whose fill AND border are tint(C.accentAlt, …), split on the dashed outline, and assert
// each family is one recipe. So a new soft-blue panel added anywhere is checked the day it appears,
// and nothing can escape the check by flipping one property — it just moves families.
// ============================================================================================

// The value is a tint() call or a raw quoted colour — NOT `[^,]+`, which would stop at the comma
// inside tint(C.accentAlt, 0.1) and silently compare three identical truncations.
const VALUE = String.raw`(tint\([^)]*\)|'[^']*'|"[^"]*")`;
const BACKGROUND = new RegExp(`backgroundColor:\\s*${VALUE}`);
const BORDER = new RegExp(`borderColor:\\s*${VALUE}`);
const ACCENT_ALT_TINT = /^tint\(\s*C\.accentAlt\s*,/;
const DASHED_OUTLINE = /borderStyle:\s*['"]dashed['"]/;

type Surface = { file: string; name: string; fill: string; border: string; dashed: boolean };

// Every style block in the tree whose fill AND border are both tint(C.accentAlt, …), split by
// whether the outline is dashed. Keyed by file + name so a failure names the right offender —
// two files can hold a same-named block.
//
// Standing assumptions (a surface that breaks one is invisible to this guard):
//  - both colours are declared inline in the same block — a surface that reaches its fill/border
//    via a spread (`...base`) or a composed `[styleA, styleB]` at the JSX site is not seen here.
//  - a surface's dashed-ness is read from a `borderStyle` in its own body; the same caveat applies.
//  - a `//` inside a string value is stripped as a comment (see sourceScan.ts stripComments) — a
//    known blind spot, contrived enough to accept.
// None of the nine known surfaces breaks these today; the reachability anchors below fail loudly if
// one is renamed or drops out, so a broken assumption surfaces as a red anchor, not a silent pass.
function accentAltSurfaces(): { solid: Surface[]; dashed: Surface[] } {
  const solid: Surface[] = [];
  const dashed: Surface[] = [];
  for (const [file, src] of shippedCode()) {
    for (const { name, body } of styleBlocks(src)) {
      const fill = BACKGROUND.exec(body);
      const border = BORDER.exec(body);
      if (!fill || !border) continue;
      if (!ACCENT_ALT_TINT.test(fill[1]) || !ACCENT_ALT_TINT.test(border[1])) continue;
      const surface: Surface = { file, name, fill: fill[1].trim(), border: border[1].trim(), dashed: DASHED_OUTLINE.test(body) };
      (surface.dashed ? dashed : solid).push(surface);
    }
  }
  return { solid, dashed };
}

const { solid: SOLID, dashed: DASHED_SURFACES } = accentAltSurfaces();
const key = (surface: Surface): string => `${surface.file} ${surface.name}`;

describe('every accentAlt surface is one of two looks', () => {
  it('the scan reaches every known surface with real values (guards a vacuous pass)', () => {
    const code = shippedCode();
    expect(code.size).toBeGreaterThan(40);
    // The scan — not this list — is what catches a NEW surface (the set-of-one assertions below
    // check any block it finds). These anchors only pin the known surfaces by name, so a drift
    // that drops one from its family fails naming THAT surface, not with an opaque count. If a
    // surface is legitimately renamed or removed, update its anchor here in the same commit.
    expect(SOLID.map(key)).toEqual(expect.arrayContaining([
      `${join('src', 'components', 'AiCoachCard.tsx')} aiCard`,
      `${join('app', 'mortgage.tsx')} contribCard`,
      `${join('app', 'milestone.tsx')} nextCard`,
      `${join('app', 'budget', 'edit.tsx')} recBtn`,
      `${join('app', '(tabs)', 'transactions.tsx')} hint`,
    ]));
    expect(DASHED_SURFACES.map(key)).toEqual(expect.arrayContaining([
      `${join('app', 'rules.tsx')} newRuleBtn`,
      `${join('app', '(tabs)', 'budgets.tsx')} addBudget`,
      `${join('app', 'category', 'index.tsx')} newBtn`,
      `${join('app', '(tabs)', 'goals.tsx')} addGoal`,
    ]));
    expect(SOLID.length).toBeGreaterThanOrEqual(5);
    expect(DASHED_SURFACES.length).toBeGreaterThanOrEqual(4);
    // and it read real tint() values, not truncations that stopped inside the call.
    for (const surface of [...SOLID, ...DASHED_SURFACES]) {
      expect(surface.fill).toMatch(/^tint\(/);
      expect(surface.border).toMatch(/^tint\(/);
    }
  });

  it('[W1] every solid wash surface declares the identical fill and border', () => {
    const fills = new Set(SOLID.map((s) => s.fill));
    const borders = new Set(SOLID.map((s) => s.border));
    // Set-of-one is the assertion; the `by` map is only so a failure names the odd one out.
    expect({ fills: [...fills], borders: [...borders], by: SOLID.map((s) => `${key(s)}: ${s.fill} / ${s.border}`) })
      .toEqual({
        fills: ['tint(C.accentAlt, 0.1)'],
        borders: ['tint(C.accentAlt, 0.22)'],
        by: SOLID.map((s) => `${key(s)}: tint(C.accentAlt, 0.1) / tint(C.accentAlt, 0.22)`),
      });
  });

  it('[W1] every dashed accentAlt button declares the identical fill and border', () => {
    const fills = new Set(DASHED_SURFACES.map((s) => s.fill));
    const borders = new Set(DASHED_SURFACES.map((s) => s.border));
    expect({ fills: [...fills], borders: [...borders], by: DASHED_SURFACES.map((s) => `${key(s)}: ${s.fill} / ${s.border}`) })
      .toEqual({
        fills: ['tint(C.accentAlt, 0.07)'],
        borders: ['tint(C.accentAlt, 0.4)'],
        by: DASHED_SURFACES.map((s) => `${key(s)}: tint(C.accentAlt, 0.07) / tint(C.accentAlt, 0.4)`),
      });
  });

  it('[W1] and the wash recipe is the second blue, not the accent', () => {
    // The drift that existed before this card: the coach card was tint(C.accent, 0.07).
    expect(tint(C.accentAlt, 0.1)).toBe('rgba(124,140,255,0.1)');
    expect(tint(C.accentAlt, 0.22)).toBe('rgba(124,140,255,0.22)');
    expect(tint(C.accentAlt, 0.1)).not.toBe(tint(C.accent, 0.1));
  });
});

// styleBlocks is the one piece of new machinery this card leans on. If it ever miscounts braces,
// the scan above could silently read the wrong props — so pin the exact failure modes the card
// names: a nested-object prop, a template literal, and an array-of-objects, all sitting BEFORE the
// colour props where the old `[^}]*` reader would have truncated.
describe('styleBlocks reads a whole block past nested braces (the [^}]* bug)', () => {
  it('reads both colour props when a nested-object prop comes first', () => {
    const src = `const s = StyleSheet.create({
      card: {
        shadowOffset: { width: 0, height: 2 },
        backgroundColor: tint(C.accentAlt, 0.1),
        borderColor: tint(C.accentAlt, 0.22),
      },
    });`;
    const card = styleBlocks(src).find((b) => b.name === 'card');
    expect(card).toBeDefined();
    expect(BACKGROUND.exec(card!.body)?.[1]).toBe('tint(C.accentAlt, 0.1)');
    expect(BORDER.exec(card!.body)?.[1]).toBe('tint(C.accentAlt, 0.22)');
    // the old reader stopped at the first nested `}`, hiding the colour props entirely.
    const truncated = /\bcard:\s*\{([^}]*)\}/.exec(src);
    expect(BACKGROUND.test(truncated![1])).toBe(false);
  });

  it('handles a template literal and an array-of-objects before the colours', () => {
    const src = `const s = {
      box: {
        marginTop: sizes[\`row-\${idx}\`],
        transform: [{ rotate: '45deg' }, { scale: 1 }],
        backgroundColor: tint(C.accentAlt, 0.07),
        borderStyle: 'dashed',
        borderColor: tint(C.accentAlt, 0.4),
      },
    };`;
    const box = styleBlocks(src).find((b) => b.name === 'box');
    expect(box).toBeDefined();
    expect(BACKGROUND.exec(box!.body)?.[1]).toBe('tint(C.accentAlt, 0.07)');
    expect(BORDER.exec(box!.body)?.[1]).toBe('tint(C.accentAlt, 0.4)');
    expect(DASHED_OUTLINE.test(box!.body)).toBe(true);
  });

  it('a border-only accentAlt block is not a wash candidate (needs both props)', () => {
    const src = `const s = { addChildBtn: { borderStyle: 'dashed', borderColor: tint(C.accentAlt, 0.4) } };`;
    const block = styleBlocks(src).find((b) => b.name === 'addChildBtn')!;
    expect(BORDER.test(block.body)).toBe(true);
    expect(BACKGROUND.test(block.body)).toBe(false); // dropped by the both-props filter
  });
});

// ============================================================================================
// accentAltSweep — WHIT-398 — [G1][G2][G3][G4] the SWEEP itself, not the token.
//
// The card's acceptance criterion is ZERO VISUAL CHANGE across 52 rewritten call sites in 19
// files. The token pin ([Q16]) and its distance from C.accent ([Q17]) live above;
// insightsSegmentedControl.gaps.screen.test.tsx pins ONE of the 52 surfaces ([A10]/[A11]).
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
// The tests themselves are exempt from the scan (shippedCode() excludes __tests__):
// insightsSegmentedControl.gaps.screen.test.tsx pins the raw literal ON PURPOSE — asserting
// against tint(C.accentAlt,…) there would pass even if the token were repainted — and
// the [Q16] token pin above pins the token's rgba output.
// ============================================================================================

const RAW_CHIP_BLUE = /['"`]rgba\(\s*124\s*,\s*140\s*,\s*255\s*[,)]/i;
// After this card the likeliest way to reintroduce the duplication is pasting the token's own
// value out of theme.ts, so the hex form is an offender everywhere except its declaration.
// No closing quote in the pattern: '#7c8cffcc' is the same blue carrying an alpha, and requiring
// the quote would let every 8-digit form through.
const RAW_CHIP_HEX = /['"`]#7c8cff/i;
const TOKEN_HOME = join('src', 'theme.ts');
const CHIP_CALL = /tint\(\s*C\.accentAlt\s*,\s*([0-9.]+)\s*\)/g;
const TINT_TOKEN_CALL = /tint\(\s*C\.([A-Za-z0-9_]+)\s*,/g;

const code = stripComments;
const CODE = shippedCode();

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
    expect(RAW_CHIP_HEX.test("backgroundColor: '#7c8cffcc'")).toBe(true); // same blue + alpha
    expect(RAW_CHIP_HEX.test("backgroundColor: '#7aa2f7'")).toBe(false);
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

// ============================================================================================
// themeInkTokens — WHIT-400 — C.accentInk and C.heroInk are both the screen background's hex
// (#16161e) with nothing tying them to it. Same shape as the OTHER_COLOR gap this card was filed
// for, but with a sharper consequence: these two are INK, drawn on the accent-blue buttons and the
// hero gradient. If C.bg is retuned and they follow by accident — or fail to follow when they
// should — the damage is unreadable text on a bright surface, not a slightly-off wedge.
// ============================================================================================

describe('the ink tokens still match the background hex they were copied from (tripwire)', () => {
  // [Q22] TRIPWIRE, not a design rule — same contract as [Q15]. accentInk is chosen to be
  // legible ON the accent blue; C.bg is chosen to be a good screen surface. They are equal today
  // by coincidence. Retuning the background is NOT a reason to repaint button ink, and this failing
  // is the prompt to decide which of the two actually needed to move.
  it('[Q22] accentInk still equals C.bg', () => {
    expect(C.accentInk).toBe(C.bg);
  });

  // [Q23] Same for the hero gradient's ink. Note heroInk2 (#1a1b26) is deliberately NOT this hex
  // and is not pinned — it is the second, lighter ink and has no background twin.
  it('[Q23] heroInk still equals C.bg', () => {
    expect(C.heroInk).toBe(C.bg);
  });

  // Both `toBe` comparisons above pass if BOTH sides are undefined, so pin that the tokens exist
  // and are real hexes. A rename refactor that updates its own call sites would otherwise leave
  // this file green with the tokens gone.
  it('[Q24] the pinned ink tokens are real hex values, so the comparisons cannot pass vacuously', () => {
    expect(C.accentInk).toMatch(/^#[0-9a-f]{6}$/);
    expect(C.heroInk).toMatch(/^#[0-9a-f]{6}$/);
    expect(C.bg).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ============================================================================================
// themeLiterals — WHIT-398 — a RATCHET on hand-written colours, generalised from the chip-blue scan.
//
// The accentAltSweep guards above prove ONE colour is written once, as a token. The same machinery
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
// ============================================================================================

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
