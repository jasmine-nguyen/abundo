// WHIT-422 — value-preservation guards for the category-palette move (src/context.tsx →
// src/categoryColors.ts) and the #cfd2ff → C.textInfo fold. These are the ADVERSARIAL gaps the
// existing suites miss; the seed/sibling/OKLCH maths and the picker-chip render are already
// covered by categoryColour.logic + overlaysPickerCreateDraftRender.screen and are NOT repeated.
//   [A-TI]  C.textInfo is exactly '#cfd2ff' — the token a future retune must not silently move.
//   [A-BC]  BUCKET_COLOR values survived the move byte-for-byte, incl. Income === C.good.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { BUCKET_COLOR } from '../categoryColors';

// ── [A-TI] the folded token still holds the shipped lavender ──────────────────
describe('WHIT-422 — C.textInfo value pin', () => {
  it('[A-TI] C.textInfo === "#cfd2ff"', () => {
    // Fail-on-revert: retune C.textInfo in theme.ts and every budget pace/status line moves with
    // it; this pins the token at its pre-move literal so that move can't be silent.
    expect(C.textInfo).toBe('#cfd2ff');
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
