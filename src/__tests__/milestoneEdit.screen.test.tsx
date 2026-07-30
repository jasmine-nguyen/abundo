// WHIT-377 — the milestone editor screen. Presses the actual screen and locks its contract: it
// hydrates from the saved plan, add/delete/reorder mutate the draft, an invalid order is blocked
// with a toast (and flagged inline) BEFORE saveMilestones is called, and a valid save hands the
// full MilestoneRecord[] to the writer then navigates back. The writer is mocked at the boundary
// (its optimistic cache write + rollback are saveMilestones.provider's own tests).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { MilestoneRecord } from '../api';

const mockSaveMilestones = jest.fn(async (_next: MilestoneRecord[]) => true);
const mockShowToast = jest.fn();
const mockBack = jest.fn();

let mockSaved: MilestoneRecord[] | undefined;
let mockIsLoading: boolean;

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: mockSaveMilestones, showToast: mockShowToast }) };
});

jest.mock('../queries', () => ({
  useIsAuthed: () => true,
  useMilestonesQuery: () => ({ data: mockSaved, isLoading: mockIsLoading }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));

import MilestoneEdit from '../../app/milestone/edit';

const SAVED: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

const labelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

beforeEach(() => {
  mockSaveMilestones.mockClear();
  mockShowToast.mockClear();
  mockBack.mockClear();
  mockSaved = SAVED;
  mockIsLoading = false;
});

it('hydrates the rows from the saved plan', () => {
  render(<MilestoneEdit />);
  expect(labelAt(0)).toBe('Start');
  expect(labelAt(1)).toBe('Midway');
  expect(labelAt(2)).toBe('Payoff');
});

it('add appends a new blank row', () => {
  render(<MilestoneEdit />);
  expect(screen.queryByTestId('milestone-label-3')).toBeNull();
  fireEvent.press(screen.getByTestId('milestone-add'));
  expect(screen.getByTestId('milestone-label-3').props.value).toBe('');
});

it('delete removes a row', () => {
  render(<MilestoneEdit />);
  fireEvent.press(screen.getByTestId('milestone-delete-1')); // remove 'Midway'
  expect(labelAt(0)).toBe('Start');
  expect(labelAt(1)).toBe('Payoff');
  expect(screen.queryByTestId('milestone-label-2')).toBeNull();
});

it('hides Delete on the last remaining row (an empty plan is not savable)', () => {
  mockSaved = [SAVED[0]];
  render(<MilestoneEdit />);
  expect(screen.queryByTestId('milestone-delete-0')).toBeNull();
});

it('blocks save while the saved plan is unresolved (undefined), even when not loading', () => {
  // A settled read error leaves data undefined with isLoading false: the editor shows the DEFAULT,
  // so saving now would overwrite a real saved plan the user has. Save must be blocked until the
  // query resolves. Fail-on-revert for the `unloaded = saved === undefined` guard (isLoading is
  // false here, so an isLoading-based guard would wrongly let this save through).
  mockSaved = undefined;
  mockIsLoading = false;
  render(<MilestoneEdit />);
  fireEvent.press(screen.getByTestId('milestone-save'));
  expect(mockSaveMilestones).not.toHaveBeenCalled();
});

it('the down arrow swaps a row with its neighbour', () => {
  render(<MilestoneEdit />);
  fireEvent.press(screen.getByTestId('milestone-down-0')); // Start ↓ past Midway
  expect(labelAt(0)).toBe('Midway');
  expect(labelAt(1)).toBe('Start');
});

it('blocks save on an invalid order — toasts, flags the row inline, and does NOT call the writer', () => {
  render(<MilestoneEdit />);
  // Swapping the first two rows leaves Start (300k, 2026) BELOW Midway (200k, 2027): the second
  // row now rises in balance → out of order.
  fireEvent.press(screen.getByTestId('milestone-down-0'));
  expect(screen.getByText(/out of order/i)).toBeTruthy(); // live inline warning
  fireEvent.press(screen.getByTestId('milestone-save'));
  expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/lower balance and a later date/i));
  expect(mockSaveMilestones).not.toHaveBeenCalled();
});

it('a valid save hands the full plan to saveMilestones and navigates back', async () => {
  render(<MilestoneEdit />);
  fireEvent.press(screen.getByTestId('milestone-save'));
  // Flush the in-flight guard's async action.
  await Promise.resolve();
  expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
  const sent = mockSaveMilestones.mock.calls[0][0];
  expect(sent.map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
  expect(sent.map((m) => m.targetBalance)).toEqual([300000, 200000, 100000]);
  await Promise.resolve();
  expect(mockBack).toHaveBeenCalled();
});
