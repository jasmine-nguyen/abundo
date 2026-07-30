// WHIT-377 — the ADVERSARIAL screen gaps the implementer's milestoneEdit.screen leaves open:
//   1. Cold-cache hydrate race: the editor opens while the ['milestones'] read is still loading
//      (data: undefined, isLoading: true) → it shows the built-in DEFAULT and BLOCKS save (so it can
//      never write the default over a real saved plan that hasn't arrived). When the real plan then
//      resolves, the `seeded` latch re-seeds the rows AND unblocks save. This is the highest-risk
//      area (the gate must key on the load state / undefined, not on a plan's length).
//   2. Reorder bounds: ↑ on the first row and ↓ on the last row are no-ops — no crash, no row
//      corruption (a swap with a non-existent neighbour would blank a row).
// Mocks mirror milestoneEdit.screen: the writer + toast + router are mocked at the boundary, and the
// query hook reads module-level `mockSaved`/`mockIsLoading` so a rerender can advance the race.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
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

describe('cold-cache hydrate race', () => {
  it('while the read is still loading: shows the built-in DEFAULT and blocks save', async () => {
    mockSaved = undefined;      // cold cache — nothing resolved yet
    mockIsLoading = true;
    render(<MilestoneEdit />);

    // The default plan (src/milestones.ts) is shown — NOT a blank form.
    expect(labelAt(0)).toBe('Kickoff');
    expect(labelAt(4)).toBe('Target');

    // Save is blocked: pressing it must NOT hand the default plan to the writer.
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });

  it('when the real saved plan resolves: the seeded latch re-seeds the rows AND unblocks save', async () => {
    mockSaved = undefined;
    mockIsLoading = true;
    const { rerender } = render(<MilestoneEdit />);
    expect(labelAt(0)).toBe('Kickoff'); // default first

    // The read resolves with the user's actual plan.
    mockSaved = SAVED;
    mockIsLoading = false;
    act(() => { rerender(<MilestoneEdit />); });

    // Re-seeded to the real plan (not left on the default).
    expect(labelAt(0)).toBe('Start');
    expect(labelAt(1)).toBe('Midway');
    expect(labelAt(2)).toBe('Payoff');

    // And save now goes through (a valid plan) — the block lifted with the load.
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
    expect(mockSaveMilestones.mock.calls[0][0].map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
  });
});

describe('reorder bounds are unreachable', () => {
  // The swap can never go out of bounds because the boundary arrows are DISABLED — that's the
  // honest, testable contract (a disabled Pressable swallows the press, so a "press does nothing"
  // test would pass even with moveRow's guard removed). moveRow keeps a bounds guard as cheap
  // defence, but it's UI-unreachable, so we assert the disabled state that makes it so.
  it('↑ on the first row is disabled', () => {
    render(<MilestoneEdit />);
    expect(screen.getByTestId('milestone-up-0')).toBeDisabled();
  });

  it('↓ on the last row is disabled', () => {
    render(<MilestoneEdit />);
    expect(screen.getByTestId('milestone-down-2')).toBeDisabled();
  });

  it('a mid-list arrow is enabled (the disable is boundary-specific, not blanket)', () => {
    render(<MilestoneEdit />);
    expect(screen.getByTestId('milestone-up-1')).not.toBeDisabled();
  });
});
