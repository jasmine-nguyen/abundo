/// <reference types="node" />
// WHIT-398 / WHIT-423 — the accentAlt bg+border surfaces are two looks, so they must be two recipes.
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
import { describe, it, expect } from '@jest/globals';
import { join } from 'path';
import { C, tint } from '../theme';
import { shippedCode, styleBlocks } from './support/sourceScan';

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
