// WHIT-324 (qa adversarial) — gaps the implementer's earnedVsSpentChart/earnedVsSpentGaps
// suites don't lock. All independent of those files:
//   [G1] the DEFICIT sliver (tiny earned vs huge spend → the *earned* bar is floored — they
//        only pin the tiny-SPEND direction).
//   [G2] the EPS/round boundary: leftover between the break-even slack (0.005) and the $1
//        rounding threshold classifies as surplus/deficit yet the headline rounds to $0, so it
//        renders "+$0 surplus" / "−$0 deficit" (characterisation of a real bug — see critique).
//   [G3] the num() coercion at the RENDER boundary (NaN / Infinity / negative earned), which the
//        pure-helper NaN test doesn't reach.
//   [G4] the tone→colour table pinned directly against TONE_COLOR's source tokens.
// Real RN preset (screen project): bar widths read off the fill View's style, text off the nodes.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { EarnedVsSpent, earnedVsSpent } from '../components/EarnedVsSpent';
import { C } from '../theme';

const colorOf = (testID: string): string =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style).color;

describe('EarnedVsSpent — deficit sliver floor [G1]', () => {
  // The mirror of the implementer's tiny-spend case: a tiny income against a large spend must
  // floor the EARNED bar to the 3% nub, not let it vanish, while the spent bar fills.
  it('a tiny earned against a large spend floors the earned bar to the 3% nub', () => {
    render(<EarnedVsSpent earned={30} spent={6389} testID="evs" />);
    // 30/6389 ≈ 0.47% would be near-invisible → floored to MIN_BAR_SHARE (3%).
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('3%');
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$6,359 deficit');
  });

  it('pure: the floored earnedShare is still the true un-floored ratio (floor is a render concern)', () => {
    const r = earnedVsSpent(30, 6389);
    expect(r.spentShare).toBe(1);
    expect(r.earnedShare).toBeCloseTo(30 / 6389); // helper stays honest; only the Bar floors
    expect(r.earnedShare).toBeLessThan(0.03);
  });
});

describe('earnedVsSpent — sub-dollar rounding boundary [G2]', () => {
  // Classification tracks the WHOLE-DOLLAR amount the card shows (Math.round), so any leftover that
  // displays as "$0" reads as broke-even — never a contradictory "+$0 surplus 🎉" / "−$0 deficit".
  it('a sub-$1 positive leftover reads as broke-even (shows $0, not a phantom surplus)', () => {
    const r = earnedVsSpent(100.3, 100);
    expect(r.even).toBe(true);
    expect(r.tone).toBe('neutral');
    expect(r.amountLabel).toBe('$0');
  });

  it('a sub-$1 negative leftover reads as broke-even (shows $0, not a phantom deficit)', () => {
    const r = earnedVsSpent(100, 100.3);
    expect(r.even).toBe(true);
    expect(r.tone).toBe('neutral');
    expect(r.amountLabel).toBe('$0');
  });

  // A half-cent leftover (the old EPS seam) now rounds to $0 → broke-even, cleanly, on both signs.
  it('a half-cent leftover on either side rounds to broke-even (no negative-labelled-surplus seam)', () => {
    expect(earnedVsSpent(0, 0.005).tone).toBe('neutral');
    expect(earnedVsSpent(0.005, 0).tone).toBe('neutral');
  });

  // A genuine whole-dollar gap must still read as a real (non-$0) deficit — the rounding didn't
  // swallow a real overspend.
  it('a clear $1+ overspend reads as a real deficit', () => {
    expect(earnedVsSpent(100, 101).amountLabel).toBe('−$1 deficit');
  });
});

describe('EarnedVsSpent — num() coercion at the render boundary [G3]', () => {
  // A loosely-mocked screen can feed the component NaN/undefined/Infinity. num() must keep the
  // bar width a valid percent string and never spill NaN%/Infinity% into the style.
  it('NaN earned coerces to 0 → empty earned bar, deficit of the whole spend', () => {
    render(<EarnedVsSpent earned={NaN} spent={1500} testID="evs" />);
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('0%');
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$1,500 deficit');
  });

  it('Infinity earned coerces to 0 (not a NaN/Infinity width)', () => {
    render(<EarnedVsSpent earned={Infinity} spent={100} testID="evs" />);
    const earnedW = screen.getByTestId('earned-bar').props.style.width as string;
    expect(earnedW).toBe('0%');
    expect(Number.isFinite(Number(earnedW.replace('%', '')))).toBe(true);
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
  });

  // A negative earned (only reachable via a corrupt mock) must not produce a negative-width bar:
  // share<0 → the Bar's `share > 0` guard keeps it at 0%, not a "-…%".
  it('a negative earned never yields a negative-width bar', () => {
    render(<EarnedVsSpent earned={-100} spent={500} testID="evs" />);
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('0%');
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
  });

  // Guard the null-render gate at the render boundary too: both non-positive after coercion → null.
  it('both non-finite/non-positive after coercion → renders nothing', () => {
    render(<EarnedVsSpent earned={NaN} spent={-5} testID="evs" />);
    expect(screen.queryByTestId('evs')).toBeNull();
  });
});

describe('EarnedVsSpent — tone→colour table pinned to source tokens [G4]', () => {
  // Assert each tone maps to its exact theme token — a swap of any of the three would slip past a
  // test that only checked "some colour". Distinct tokens (surplus≠good, bad, textBright).
  it('surplus headline uses C.surplus (distinct from the earned bar token C.good)', () => {
    render(<EarnedVsSpent earned={200} spent={50} testID="evs" />);
    expect(colorOf('earned-vs-spent-amount')).toBe(C.surplus);
    expect(C.surplus).not.toBe(C.good); // the headline is its own brighter green
  });
  it('deficit headline uses C.bad', () => {
    render(<EarnedVsSpent earned={50} spent={200} testID="evs" />);
    expect(colorOf('earned-vs-spent-amount')).toBe(C.bad);
  });
  it('broke-even headline uses C.textBright (neutral)', () => {
    render(<EarnedVsSpent earned={200} spent={200} testID="evs" />);
    expect(colorOf('earned-vs-spent-amount')).toBe(C.textBright);
  });
});
