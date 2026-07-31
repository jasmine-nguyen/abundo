// WHIT-372 — adversarial gap coverage on the /mortgage HERO (the previously-buggy, ungated site).
// The implementer locks 1000->"99% gone" and 0->"100% gone". These add the two hero states the
// card's `paidDown>0` gate hides but the hero (gated only on factsReady && balanceKnown) still
// renders, proving the shared label stays coherent there. Same mock scaffold as mortgageHero.screen.
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

describe('mortgage hero — WHIT-372 label states the card gate hides', () => {
  // [E5] Balance EXACTLY at the original (fresh loan / redraw back to full). The card falls to its
  // plain "owing" line here, but the hero has no paidDown>0 gate: it renders the label, and it must
  // read a coherent "0% gone" beside "$500,000 to go" — never a stray 100 or a NaN.
  it('[E5] balance at the original shows a coherent "0% gone", never "100% gone"', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 500000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('0% gone')).toBeTruthy();
    expect(screen.queryByText('100% gone')).toBeNull();
    expect(screen.getByText('$500,000 to go')).toBeTruthy();
  });
});
