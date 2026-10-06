// WHIT-774: the milestone editor's TARGET BALANCE box is the shared MoneyField. Typing into a
// row's balance box (test tag milestone-balance-N, carried by MoneyField's new testID prop) and
// saving sends the parsed number to saveMilestones.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen, fireEvent, act, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import type { MilestoneRecord } from '../api';
import { MoneyField } from '../components/MoneyField';
import { C } from '../theme';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockSaveMilestones = jest.fn(async (_next: MilestoneRecord[]) => true);
const mockShowToast = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: mockSaveMilestones, showToast: mockShowToast }) };
});

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import MilestoneEdit from '../../app/milestone/edit';

const server = installFakeServer();
useTestQueryClient();

const SAVED: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockSaveMilestones.mockClear();
  mockShowToast.mockClear();
  server.seed('/milestones', SAVED);
});

describe('WHIT-774 milestone editor target balance box', () => {
  it("each row's balance box is the shared money box, tagged per row, and keeps the darker background", async () => {
    await renderWithQueries(<MilestoneEdit />);
    const fields = screen.UNSAFE_getAllByType(MoneyField);
    expect(fields).toHaveLength(SAVED.length);
    const input = within(fields[0]).getByTestId('milestone-balance-0');
    expect(input.props.value).toBe('300000');
    // Sign-off option A: the box stays C.bg so it contrasts with the C.card row card.
    let box = input.parent;
    while (box && !StyleSheet.flatten(box.props.style)?.backgroundColor) box = box.parent;
    expect(StyleSheet.flatten(box?.props.style).backgroundColor).toBe(C.bg);
  });

  it('user can type a new target balance and save it', async () => {
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.changeText(screen.getByTestId('milestone-balance-0'), '600000');
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
    const sent = mockSaveMilestones.mock.calls[0][0];
    expect(sent.map((m) => m.targetBalance)).toEqual([600000, 200000, 100000]);
  });
});
