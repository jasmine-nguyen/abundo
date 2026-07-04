// GAP screen test for the Home Loan Milestone screen (WHIT-8): the fully-cleared
// state the implementer's milestone.screen.test.tsx doesn't render — every Sprint
// target reached. The "NEXT MILESTONE" callout must disappear (nextMilestone null
// gates it) and the hero must report "5 of 5 milestones reached" rather than a
// stale next-target prompt. Context is injected so the real milestoneView runs.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

import Milestone from '../../app/milestone';

function state(over: Partial<AppContext>): AppContext {
  return {
    homeLoan: { balance: null, asOf: null },
    loanFacts: { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 },
    category: () => undefined,
    ...over,
  } as unknown as AppContext;
}

it('hides the NEXT MILESTONE callout once every target is cleared', () => {
  // 40000 is below the Sprint 4 target (55000): all five milestones cleared.
  mockState = state({ homeLoan: { balance: 40000, asOf: '2029-07-01T00:00:00.000Z' } });
  render(<Milestone />);

  expect(screen.getByText('5 of 5 milestones reached')).toBeTruthy();
  // No next target to chase => the callout and its "to go" line are gone.
  expect(screen.queryByText('NEXT MILESTONE')).toBeNull();
  expect(screen.queryByText(/to go$/)).toBeNull();
});
