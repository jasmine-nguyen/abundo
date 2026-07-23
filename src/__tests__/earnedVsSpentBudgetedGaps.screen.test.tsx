// WHIT-314 GAPS (component), updated for WHIT-319's per-side scale — the overlay edges the
// implementer's suite doesn't pin: a tiny actual against its OWN large budget (a legitimate
// sliver of that budget), an actual EXACTLY on its budget (fill hugs the target, no overflow), a
// very large budget (no NaN/overflow), and that the target track is the FADED tint (not the solid
// hue). Reads the REAL earnedVsSpentBudgeted / EarnedVsSpent + tint, so a regression in the
// per-side max, the fill widths, or the faded track fails here.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpentBudgeted } from '../components/EarnedVsSpent';
import { C, tint } from '../theme';

describe('earnedVsSpentBudgeted — shared-scale edges (WHIT-314 gaps)', () => {
  // [G7] Per-side scale (WHIT-319): a $30 spend against a $4000 budget is a legitimate sliver of
  // THAT budget, while the earned bar (no income budget) scales to its own actual and stays full.
  // Guards against a regression back to a shared max (which would squish the earned bar too).
  it('[G7] each bar scales to its OWN budget — a tiny spend is a sliver of ITS budget', () => {
    const r = earnedVsSpentBudgeted(50, 30, 0, 4000);
    expect(r.budgetedSpentShare).toBe(1);           // 4000 = the spent side's own max
    expect(r.spentShare).toBe(30 / 4000);           // 0.0075 of its own budget (correctly small)
    expect(r.earnedShare).toBe(1);                  // earned scales to its own actual (50), full bar
    expect(r.budgetedEarnedShare).toBe(0);          // no income budget
  });

  // [G8] actual EXACTLY equals its budget (and is the shared max): share == targetShare, so the
  // solid fill exactly covers the target track — no overflow, no gap. Break-even income means
  // the surplus copy reads the budget difference, not the actuals.
  it('[G8] an actual exactly on its budget → share equals targetShare (no overflow)', () => {
    const r = earnedVsSpentBudgeted(2000, 0, 2000, 0);
    expect(r.earnedShare).toBe(1);
    expect(r.budgetedEarnedShare).toBe(1);          // fill hugs the target exactly
    expect(r.earnedShare).toBe(r.budgetedEarnedShare);
    expect(r.surplusLabel).toBe('$2,000 budgeted surplus'); // 2000 income budget − 0 spend budget
  });

  // [G9] very large budgets: shares stay finite in [0,1], no NaN spilling into a width.
  it('[G9] very large budgets keep every share finite and within [0,1]', () => {
    const r = earnedVsSpentBudgeted(1_500_000, 900_000, 2_000_000, 1_800_000);
    for (const v of [r.earnedShare, r.spentShare, r.budgetedEarnedShare, r.budgetedSpentShare]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(r.budgetedEarnedShare).toBe(1);          // 2,000,000 = max
    expect(r.surplusLabel).toBe('$200,000 budgeted surplus');
  });
});

describe('EarnedVsSpent — overlay render edges (WHIT-314 gaps)', () => {
  // [G10] the target track must be the FADED tint of the bar colour, drawn behind the solid
  // actual — this is the whole "faded-hue target behind each bar" requirement, which the
  // implementer's suite checks positionally but not by colour. Locks tint(color, 0.22).
  it('[G10] the target tracks are the faded 0.22 tint of the bar colour, actual is solid', () => {
    render(
      <EarnedVsSpent earned={100} spent={100} budgeted={{ budgetedEarned: 200, budgetedSpent: 150 }} testID="evs" />,
    );
    expect(screen.getByTestId('earned-bar-target').props.style.backgroundColor).toBe(tint(C.good, 0.22));
    expect(screen.getByTestId('spent-bar-target').props.style.backgroundColor).toBe(tint(C.bad, 0.22));
    expect(screen.getByTestId('earned-bar').props.style.backgroundColor).toBe(C.good);   // solid on top
    expect(screen.getByTestId('spent-bar').props.style.backgroundColor).toBe(C.bad);
  });

  // [G11] sliver render: a tiny actual against a large budgeted-spend max draws a hair-thin fill
  // over a full-width target — pins the exact width strings the shared scale produces.
  it('[G11] a sliver actual over a full-width target keeps exact fill widths', () => {
    render(
      <EarnedVsSpent earned={0} spent={30} budgeted={{ budgetedEarned: 0, budgetedSpent: 4000 }} testID="evs" />,
    );
    expect(screen.getByTestId('spent-bar-target').props.style.width).toBe('100%');       // 4000 = max
    expect(screen.getByTestId('spent-bar').props.style.width).toBe(`${(30 / 4000) * 100}%`); // 0.75%
  });
});
