// WHIT-422 — value-preservation guards for the category-palette move (src/context.tsx →
// src/categoryColors.ts) and the #cfd2ff → C.textInfo fold. These are the ADVERSARIAL gaps the
// existing suites miss; the seed/sibling/OKLCH maths and the picker-chip render are already
// covered by categoryColour.logic + overlaysPickerCreateDraftRender.screen and are NOT repeated.
//   [A-TI]  C.textInfo is exactly '#cfd2ff' — the token a future retune must not silently move.
//   [A-EP]  the EXPENSE budget pace sub-label ("under pace"/"on pace") is that muted colour.
//           (Existing #cfd2ff pins only exercise the INCOME earn-target branch.)
//   [A-BC]  BUCKET_COLOR values survived the move byte-for-byte, incl. Income === C.good.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { BUCKET_COLOR } from '../categoryColors';
import { budgetViews } from '../context';
import { makeState, cat, budget } from './factory';

// ── [A-TI] the folded token still holds the shipped lavender ──────────────────
describe('WHIT-422 — C.textInfo value pin', () => {
  it('[A-TI] C.textInfo === "#cfd2ff"', () => {
    // Fail-on-revert: retune C.textInfo in theme.ts and every budget pace/status line moves with
    // it; this pins the token at its pre-move literal so that move can't be silent.
    expect(C.textInfo).toBe('#cfd2ff');
  });
});

// ── [A-EP] EXPENSE pace sub-label uses the muted token (NEW branch — income-only before) ──
describe('WHIT-422 — expense budget pace colour is the muted token', () => {
  // Lifestyle (expense) category; cycleLen 14 / daysLeft 7 → elapsed 0.5 → target = 0.5 * budget.
  const expenseRow = (posted: number) => budgetViews(makeState({
    categories: [cat({ id: 'coffee', bucket: 'Lifestyle' })],
    budgets: [budget({ id: 'coffee', budget: 100, posted, pending: 0 })],
    cycleLen: 14, daysLeft: 7,
  })).rows[0];

  it('[A-EP] "under pace" (spent 10 vs target 50) → paceColor is #cfd2ff', () => {
    const row = expenseRow(10);
    expect(row.paceLabel).toContain('under pace');
    // Fail-on-revert: change context.tsx line ~1807 paceColor from C.textInfo to any other token → red.
    expect(row.paceColor).toBe('#cfd2ff');
    expect(row.paceColor).toBe(C.textInfo);
  });

  it('[A-EP] exactly "on pace" (spent 50 == target 50) → paceColor is #cfd2ff', () => {
    const row = expenseRow(50);
    expect(row.paceLabel).toBe('on pace');
    // Fail-on-revert: change context.tsx line ~1808 paceColor from C.textInfo → red.
    expect(row.paceColor).toBe('#cfd2ff');
  });
});

// ── [A-BC] BUCKET_COLOR values preserved by the file move ─────────────────────
describe('WHIT-422 — BUCKET_COLOR value preservation', () => {
  it('[A-BC] the four bucket colours are byte-for-byte what shipped pre-move', () => {
    // Living/Lifestyle/Savings are pinned to NO other test; the screen test only compares a rendered
    // chip against BUCKET_COLOR itself (tautological — both move together). This pins the literals.
    expect(BUCKET_COLOR).toEqual({
      Living: '#7aa2f7',
      Lifestyle: '#bb9af7',
      Income: C.good,       // Income tracks the shared token, as before the move
      Savings: '#73daca',
    });
  });
});
