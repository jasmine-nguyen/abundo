// WHIT-671 — the "Update balance" pop-up opened the way the app opens it: the Goals hub has already
// loaded the goals from the server, then the sheet opens and prefills the goal's saved balance.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const CAR_LOAN = {
  id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2027-08-15', baseline: 20000,
  account_id: null, manual_balance: 12000, manual_as_of: '2026-07-01',
};

const fns = {
  saveGoal: jest.fn(async (_id: string, _body: unknown) => true), showToast: jest.fn(), setSheet: jest.fn(),
  readSheetDraft: () => undefined, writeSheetDraft: () => {},
};

beforeEach(() => {
  fns.saveGoal.mockClear();
  fns.showToast.mockClear();
  fns.setSheet.mockClear();
  resetAuth();
});

describe('goal balance pop-up over the fake server', () => {
  it('user can open a manual goal from the server, see its balance prefilled, and save a new one', async () => {
    server.seed('/goals', [CAR_LOAN]);
    const state = { sheet: { mode: 'goalbalance', goalId: 'g2' }, toast: null, ...fns } as unknown as AppContext;
    await openOverlays(state, (next) => { mockState = next; });

    expect(screen.getByText(/Car loan/)).toBeTruthy();
    expect(screen.getByDisplayValue('12000')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9500');
    await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });

    expect(fns.saveGoal).toHaveBeenCalledTimes(1);
    const [id, body] = fns.saveGoal.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('g2');
    expect(body).toMatchObject({ name: 'Car loan', direction: 'paydown', baseline: 20000, manual_balance: 9500 });
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });
});
