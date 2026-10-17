// ABU-82 — the bank sync sheet, opened by tapping the "Updated · … ›" line: one row per account,
// name on the left and the bank's last sync time on the right, an amber dot only on accounts over
// a day old, and Done closes it.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { screen, fireEvent, within } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { C } from '../theme';
import { styleOf } from './support/layout';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';
import { pinToday } from './support/clock';

installFakeServer();
useTestQueryClient();

const setSheet = jest.fn();

beforeEach(() => {
  pinToday(new Date('2026-09-18T15:00:00+10:00'));
  setSheet.mockClear();
  resetAuth();
});

afterEach(() => { jest.useRealTimers(); });

it('lists each account with its sync time, an amber dot only on the one over a day old, and Done closes it', async () => {
  const accounts = [
    { id: 'up-spending', name: 'Up Spending', at: new Date('2026-09-18T08:10:00+10:00').getTime() },
    { id: 'westpac-altitude', name: 'Westpac Altitude Qantas Black', at: new Date('2026-09-16T07:55:00+10:00').getTime() },
  ];
  const state = { sheet: { mode: 'bankSync', accounts }, toast: null, setSheet } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });

  const up = within(await screen.findByTestId('bank-sync-row-up-spending'));
  expect(up.getByText('Up Spending')).toBeTruthy();
  expect(up.getByText('8:10am')).toBeTruthy();
  expect(screen.queryByTestId('bank-sync-dot-up-spending')).toBeNull();

  const westpac = within(screen.getByTestId('bank-sync-row-westpac-altitude'));
  expect(westpac.getByText('Westpac Altitude Qantas Black')).toBeTruthy();
  expect(westpac.getByText('16 Sep, 7:55am')).toBeTruthy();
  expect(styleOf(westpac.getByTestId('bank-sync-dot-westpac-altitude')).color).toBe(C.warn);

  fireEvent.press(screen.getByText('Done'));
  expect(setSheet).toHaveBeenCalledWith(null);
});
