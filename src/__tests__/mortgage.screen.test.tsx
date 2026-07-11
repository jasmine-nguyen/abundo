// WHIT-233 — the mortgage screen relocated out of the Goal tab to its own stack route
// (app/mortgage). This locks the RELOCATION-specific behaviour: it renders standalone WITHOUT
// a NavBarsProvider (proving it uses the <Header showBack /> + plain ScrollView detail pattern,
// not the tab's ScrollChromeHeader, which would throw here), and its header reads "The mortgage".
// The mortgage CONTENT (payoff cards, repayment, equity, milestone link) is covered by the
// suites repointed to this screen (goals.paydown / repayment.* / milestone / goalErrorStates).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ fireRepayment: jest.fn() }) };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Mortgage from '../../app/mortgage';

beforeEach(() => {
  mockGoal = makeGoalData();
});

it('renders standalone (no NavBarsProvider) with a "The mortgage" header', () => {
  // If this screen still used ScrollChromeHeader it would throw here (no NavBarsProvider),
  // so a clean render is itself the relocation assertion.
  render(<Mortgage />);
  expect(screen.getByText('The mortgage')).toBeTruthy();
});

it('shows the live balance owing in the hero when facts are unset', () => {
  mockGoal = makeGoalData({
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: 596642, asOf: null },
  });
  render(<Mortgage />);
  expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
  expect(screen.getByText('$596,642')).toBeTruthy();
});
