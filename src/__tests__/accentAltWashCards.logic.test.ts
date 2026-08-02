/// <reference types="node" />
// WHIT-398 — the three "wash cards" are one look, so they must be one recipe.
//
// A wash card is a soft translucent blue panel with a matching hairline border: the AI coach card
// on Insights, the contribution card on Mortgage, the next-milestone card on Milestone. They are
// meant to read as the same kind of surface.
//
// They had already drifted: AiCoachCard was built from C.accent at 0.07 fill while the other two
// used the second blue at 0.1 — a slightly greener, fainter panel. Nothing caught it, because each
// screen's stylesheet is module-private and no test rendered two of them together.
//
// Scanning the source is the honest way to assert this. The alternative — rendering all three
// screens and comparing pixels — would need three sets of mocks and would still only prove the
// values matched on one render path. The property is "these three declarations agree", so that is
// what this reads.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { C, tint } from '../theme';

const ROOT = join(__dirname, '..', '..');

const WASH_CARDS = [
  { label: 'AiCoachCard aiCard', file: join('src', 'components', 'AiCoachCard.tsx'), style: 'aiCard' },
  { label: 'mortgage contribCard', file: join('app', 'mortgage.tsx'), style: 'contribCard' },
  { label: 'milestone nextCard', file: join('app', 'milestone.tsx'), style: 'nextCard' },
];

// Pull `<style>: { ... }` off the stylesheet and read the two colour props out of it.
function washRecipe(file: string, style: string): { fill: string; border: string } {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const decl = new RegExp(`\\b${style}:\\s*\\{([^}]*)\\}`).exec(src);
  if (!decl) throw new Error(`no ${style} style in ${file}`);
  // The value is a tint() call or a raw quoted colour — NOT `[^,]+`, which would stop at the
  // comma inside tint(C.accentAlt, 0.1) and silently compare three identical truncations.
  const VALUE = String.raw`(tint\([^)]*\)|'[^']*'|"[^"]*")`;
  const fill = new RegExp(`backgroundColor:\\s*${VALUE}`).exec(decl[1]);
  const border = new RegExp(`borderColor:\\s*${VALUE}`).exec(decl[1]);
  if (!fill || !border) throw new Error(`${style} in ${file} has no backgroundColor/borderColor`);
  return { fill: fill[1].trim(), border: border[1].trim() };
}

const RECIPES = WASH_CARDS.map((card) => ({ ...card, ...washRecipe(card.file, card.style) }));

describe('the three wash cards are one look', () => {
  it('the scan found all three, with real values (guards a vacuous pass)', () => {
    expect(RECIPES).toHaveLength(3);
    for (const recipe of RECIPES) {
      expect(recipe.fill).toMatch(/^tint\(/);
      expect(recipe.border).toMatch(/^tint\(/);
    }
    // and the reader genuinely reads — a regex that silently matched nothing would throw above,
    // but a regex that matched the WRONG prop would not, so pin one known value outright.
    expect(washRecipe(join('app', 'mortgage.tsx'), 'contribCard').fill).toBe('tint(C.accentAlt, 0.1)');
  });

  it('[W1] all three declare the identical fill and border', () => {
    const fills = new Set(RECIPES.map((r) => r.fill));
    const borders = new Set(RECIPES.map((r) => r.border));
    // Set-of-one is the assertion; the map is only so a failure names the odd one out.
    expect({ fills: [...fills], borders: [...borders], by: RECIPES.map((r) => `${r.label}: ${r.fill} / ${r.border}`) })
      .toEqual({
        fills: ['tint(C.accentAlt, 0.1)'],
        borders: ['tint(C.accentAlt, 0.22)'],
        by: RECIPES.map((r) => `${r.label}: tint(C.accentAlt, 0.1) / tint(C.accentAlt, 0.22)`),
      });
  });

  it('[W1] and that recipe is the second blue, not the accent', () => {
    // The drift that existed before this card: the coach card was tint(C.accent, 0.07).
    expect(tint(C.accentAlt, 0.1)).toBe('rgba(124,140,255,0.1)');
    expect(tint(C.accentAlt, 0.22)).toBe('rgba(124,140,255,0.22)');
    expect(tint(C.accentAlt, 0.1)).not.toBe(tint(C.accent, 0.1));
  });
});
