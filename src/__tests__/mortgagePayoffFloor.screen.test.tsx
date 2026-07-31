// WHIT-391 GAPS (hero, rendered) — the /mortgage hero at the CANONICAL sub-0.5% paydown, screen-level.
// The diffed mortgageOwingEdges.screen only re-renders the 0.5 knife-edge; this renders the card's own
// $1,200/$500k example end-to-end AND proves the progress bar still fills to the TRUE 0.24% while the
// headline reads "1% gone" — the exact reconcile WHIT-391 is about. Same mock scaffold as the sibling
// hero suites: the REAL goalView runs over LOAN_FACTS + an injected balance.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({}) };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Mortgage from '../../app/mortgage';

beforeEach(() => { mockGoal = makeGoalData(); });

describe('mortgage hero — WHIT-391 sub-0.5% paydown, rendered', () => {
  // [F7] The card's canonical example, rendered: $1,200 paid of a $500k loan (0.24%). The payoff block
  // shows "$1,200" next to "1% gone" (NOT "0% gone"), with the honest "$498,800 to go". Reverting the
  // WHIT-391 floor drops the headline to "0% gone" and reddens the last two assertions.
  it('[F7] $1,200 paid on $500k renders "$1,200" next to "1% gone", never "0% gone"', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$1,200')).toBeTruthy();
    expect(screen.getByText('1% gone')).toBeTruthy();
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.getByText('$498,800 to go')).toBeTruthy();
  });

  // [F8] The reconcile's OTHER half: the label is floored to 1, but the progress bar must still fill to
  // the TRUE 0.24% (Bar width={`${paidPct}%`}), NOT snap to 1%. So the bar is visibly near-empty while
  // the words say "1% gone" — deliberate and honest. Assert the serialized tree carries a "0.24%" width
  // next to "1% gone". Reverting the floor leaves the bar at 0.24% but the headline back at 0% (a regress
  // of the reconcile); clamping the BAR to the label (a wrong "fix") would drop the 0.24% width and redden.
  it('[F8] the progress bar fills to the true 0.24%, not the floored 1% (label and bar diverge honestly)', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('1% gone')).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('0.24%');        // Bar fill width uses the raw paidPct
    expect(tree).not.toContain('width":"1%'); // ...and is NOT snapped to the floored label
  });
});
