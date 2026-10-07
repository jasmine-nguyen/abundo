// WHIT-813 — Goals cards look tappable and read clearly. Through the fake server, the REAL screen
// data code and the REAL balanceGoalView:
//  - goal cards and the plain home-loan card carry an arrow and take the shared PRESSED style;
//  - the pace foot reads "Set aside $X each payday" in normal text colour (link blue stays only on
//    the past-due nudge);
//  - the milestone line names the next step ("Next: <label>") or says "All milestones reached";
//  - the goal page shows the same milestone wording, with no arrow in its top row.
// Clock pinned to Sat 11 Jul 2026 (paydays Jul18, Aug1, Aug15).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, GOAL_START } from './support/goalPace';
import { pressedStyle } from './support/pressedStyle';
import { resetRouter, setParams } from './support/routerMock';
import { C, PRESSED } from '../theme';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';
import GoalDetail from '../../app/goal/[id]';

type Node = { parent: Node | null; props: Record<string, unknown>; findAll: (p: (n: Node) => boolean) => Node[] };

// The chevron glyph's path, as drawn by Glyph name="chevron". The svg's xml is passed down a few
// wrapper layers, so count only the outermost node carrying it.
const CHEVRON_PATH = 'M9 6l6 6-6 6';
const chevrons = (root: Node) =>
  root.findAll((n) => typeof n.props.xml === 'string' && n.props.xml.includes(CHEVRON_PATH) && n.parent?.props.xml !== n.props.xml);

// The Pressable itself (its style is still the pressed-state function), not the host View under it.
const pressableById = (testID: string) => {
  const hits = (screen.UNSAFE_root as unknown as Node).findAll((n) => n.props.testID === testID && typeof n.props.style === 'function');
  expect(hits.length).toBe(1);
  return hits[0];
};

const colorOf = (node: { props: { style?: unknown } }) => (StyleSheet.flatten(node.props.style as never) as { color?: string }).color;

const server = installFakeServer();
useTestQueryClient();

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
  server.seed('/milestones', []);
});
afterEach(() => { jest.useRealTimers(); });

describe('Goals tab cards', () => {
  // Balance 4,000 of 10,000 → $2,000 each payday; both milestones (2,000 and 3,000) already passed.
  const SAVED: GoalRecord = {
    id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
    checkpoints: [{ id: 'a', label: '2k', amount: 2000 }, { id: 'b', label: '3k', amount: 3000 }],
  };
  // Owes 12,000 (from 20,000). The ladder is out of order: 15k is passed; of 5k and 10k the next
  // step down is 10k.
  const PAYDOWN: GoalRecord = {
    id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown', target_amount: 0, target_date: '2026-08-15',
    baseline: 20000, manual_balance: 12000, manual_as_of: '2026-07-01', account_id: null,
    checkpoints: [{ id: 'c', label: '5k', amount: 5000 }, { id: 'd', label: '15k', amount: 15000 }, { id: 'e', label: '10k', amount: 10000 }],
  };
  const PAST_DUE: GoalRecord = { id: 'od', name: 'Holiday', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-06-01', account_id: 'up-spending' };

  it('goal cards and the plain home-loan card show an arrow and press feedback, with the clearer pace and milestone lines', async () => {
    seedHubWith(server, { goals: [SAVED, PAYDOWN, PAST_DUE], balances: { 'up-spending': 4000 } });
    await renderWithQueries(<Goals />);

    // An arrow on every goal card and on the plain home-loan card.
    for (const id of ['goal-card-g1', 'goal-card-g2', 'goal-card-od', 'mortgage-link']) {
      expect(chevrons(screen.getByTestId(id) as unknown as Node)).toHaveLength(1);
    }
    expect(screen.getByTestId('mortgage-owing')).toBeTruthy(); // on the plain loan card

    // The shared pressed style on press, solid at rest.
    for (const id of ['goal-card-g1', 'mortgage-link']) {
      const card = pressableById(id);
      expect(pressedStyle(card, false).opacity).toBeUndefined();
      const pressed = pressedStyle(card, true);
      expect(pressed.opacity).toBe(PRESSED.opacity);
      expect(pressed.transform).toEqual(PRESSED.transform);
    }

    // The pace foot: plain wording in normal text colour, not link blue.
    const foot = screen.getByText('Set aside $2,000 each payday');
    expect(colorOf(foot)).toBe(C.text);
    // Link blue stays on the tappable past-due nudge.
    expect(colorOf(screen.getByText('Past your date — pick a new one?'))).toBe(C.accentSoft);

    // The milestone line names the closest unreached step, not the first in the list.
    expect(screen.getByTestId('goal-checkpoints-g2')).toHaveTextContent('Next: 10k');
  });
});

describe('goal page', () => {
  // $5,000 of $10,000 → $1,667 each payday over 3 paydays; "First buffer" passed, "Nearly there" next.
  const GOAL: GoalRecord = {
    id: 'ef', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000,
    account_id: 'up-spending', ...GOAL_START, start_balance: 0,
    checkpoints: [{ id: 'c1', label: 'First buffer', amount: 2000 }, { id: 'c2', label: 'Nearly there', amount: 7500 }],
  };

  it('shows the same pace and milestone wording, with no arrow in its top row', async () => {
    seedHubWith(server, { goals: [GOAL], balances: { 'up-spending': 5000 } });
    setParams({ id: 'ef' });
    await renderWithQueries(<GoalDetail />);

    expect(screen.getByTestId('goal-checkpoints-ef')).toHaveTextContent('Next: Nearly there');
    expect(chevrons(screen.UNSAFE_root as unknown as Node)).toHaveLength(0);
  });
});
