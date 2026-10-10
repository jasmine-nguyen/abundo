// WHIT-495 — the Settings tab became a header gear (top-left) on all five tabs, pushing the
// /settings route.
//   The gear is present on ALL FIVE remaining tabs and tapping it navigates to /settings. Since WHIT-841 the shared header
//      draws it itself (no `left` prop), so a header that stops drawing it fails here.
import { it, expect, jest, describe, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { routerSpies, resetRouter } from './support/routerMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// Real selectors (budgetViews / transactionGroups / accountSummaries / categoryBreakdown / …),
// benign useAppContext covering every slice the five screens read.
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({
  openMultiPicker: jest.fn(), showToast: jest.fn(), openGoalBalance: jest.fn(),
  setSheet: jest.fn(), rules: [], cycleName: 'Fortnightly',
})));
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());

import Budgets from '../../app/(tabs)/budgets';
import Transactions from '../../app/(tabs)/transactions';
import Accounts from '../../app/(tabs)/accounts';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

// Every tab reads the server defaults (empty lists, a zero uncategorized count).
installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// The whole point of the ticket: the gear must be on EVERY remaining tab. A dropped `left` on any
// one screen makes that screen's case fail here.
describe.each([
  ['Budgets', <Budgets />],
  ['Transactions', <Transactions />],
  ['Accounts', <Accounts />],
  ['Insights', <Insights />],
  ['Goals', <Goals />],
] as [string, React.ReactElement][])('the Settings gear is present on %s', (_name, ui) => {
  it('renders a "Settings" header button that opens /settings', async () => {
    await renderWithQueries(ui);
    const btn = screen.getByLabelText('Settings');
    fireEvent.press(btn);
    expect(routerSpies.push).toHaveBeenCalledWith('/settings');
  });
});
