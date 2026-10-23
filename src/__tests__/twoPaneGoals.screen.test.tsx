// ABU-111 — the Goals tab on a wide screen (the iPhone Duo's inner screen): tapping a goal card or
// the home loan card shows it beside the list instead of opening a new page; a goal deleted
// elsewhere clears the pane; folding to a narrow screen reopens the open item full screen.
// Real screen + AppProvider over the fake server; only the window-width check is switched.
// (Narrow taps pushing /goal/<id> and /mortgage are covered by goalDetail.screen.test.tsx and goalsHub.)
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct, releaseAndSettle, settle } from './support/renderWithQueries';
import { renderWithApp, WithApp, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { routerSpies, setFocused, resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, GOAL_START } from './support/goalPace';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { TAB_BAR_CLEARANCE } from '../motion/ScrollChromeHeader';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const GOAL: GoalRecord = {
  id: 'ef 1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000,
  account_id: 'up-spending', ...GOAL_START, start_balance: 0,
  checkpoints: [{ id: 'c1', label: 'First buffer', amount: 2000 }],
};
// Two days before the pinned today, so the Home loan screen celebrates it as just landed.
const REPAYMENT = { amount: 1440, date: '2026-07-09', principal: 1208, interest: 232 };

// The goal page's Edit button and milestone rows exist only on the detail, never on the tab's cards.
const goalDetailShown = () => screen.queryByTestId('goal-detail-edit') !== null;
const goalCard = () => screen.getByTestId('goal-card-ef 1');

async function drawAndOpen(testID: string) {
  const view = await renderWithApp(<Goals />);
  await fireEvent.press(await screen.findByTestId(testID));
  return view;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  resetAppProbe();
  resetRouter();
  mockWide = true;
  pinToday(GOAL_TODAY);
  seedHubWith(server, { goals: [GOAL], balances: { 'up-spending': 5000 } });
  server.seed('/repayment', REPAYMENT);
  server.seed('/milestones', SAVED_MILESTONES);
});
afterEach(() => { jest.useRealTimers(); });

describe('wide screen', () => {
  it('tapping a goal shows it beside the list (highlighted card, no new page, no back arrow, clear of the tab bar), and deleting it elsewhere clears the pane', async () => {
    await drawAndOpen('goal-card-ef 1');

    await waitFor(() => expect(goalDetailShown()).toBe(true));
    expect(screen.getByTestId('goal-milestone-c1')).toBeTruthy();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Back')).toBeNull();
    expect(goalCard().props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));

    let paneScroll = screen.getByTestId('goal-milestone-c1').parent;
    while (paneScroll && paneScroll.type !== 'RCTScrollView') paneScroll = paneScroll.parent;
    expect(paneScroll).toBeTruthy();
    expect(StyleSheet.flatten(paneScroll!.props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(TAB_BAR_CLEARANCE);

    server.seed('/goals', []);
    await refreshInAct(() => queryClient.refetchQueries());
    await settle();

    expect(goalDetailShown()).toBe(false);
    expect(screen.queryByText('Goal not found')).toBeNull();
    expect(screen.getByText('Select a goal')).toBeTruthy();
  });

  it('a goal open while its goals reload from scratch stays open until they arrive', async () => {
    await drawAndOpen('goal-card-ef 1');
    await waitFor(() => expect(goalDetailShown()).toBe(true));

    const held = server.hold('/goals');
    await refreshInAct(() => { queryClient.resetQueries(); });
    expect(screen.queryByText('Select a goal')).toBeNull();

    await releaseAndSettle(held);
    expect(goalDetailShown()).toBe(true);
  });

  it('tapping the home loan card shows the Home loan screen beside the list, with its just-landed repayment', async () => {
    await drawAndOpen('mortgage-link');

    expect(await screen.findByTestId('repayment-landed')).toHaveTextContent(/\$1,208 off your loan/);
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Back')).toBeNull();
    expect(screen.getByTestId('mortgage-link').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  });

  it.each([
    ['goal-card-ef 1', true, ['/goal/ef%201']],
    ['mortgage-link', true, ['/mortgage']],
    ['goal-card-ef 1', false, []],
    ['mortgage-link', false, []],
  ])('folding to a narrow screen with %s open (tab focused: %p) pushes %j', async (testID, focused, pushed) => {
    const view = await drawAndOpen(testID);
    await settle();
    expect(routerSpies.push).not.toHaveBeenCalled();
    setFocused(focused);

    mockWide = false;
    await refreshInAct(() => view.rerender(<WithApp><Goals /></WithApp>));

    expect(routerSpies.push.mock.calls.map(([href]) => href)).toEqual(pushed);
    expect(goalDetailShown()).toBe(false);
    expect(screen.queryByTestId('repayment-landed')).toBeNull();
  });
});
