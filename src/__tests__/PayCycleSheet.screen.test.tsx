// Screen test: the Pay cycle sheet (WHIT-9 UI). Verifies the three length options
// render with the current one selected, that tapping a length calls
// setPayCycleLength, and that picking a date drives setPayday through the
// (event, date) extraction that fixed the picker crash. Seeded from the QA
// "Automatable (UI)" pay-cycle scenarios. Runs on iOS (RN preset default), which
// renders the inline compact picker.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
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
import { renderedPickerProps } from './support/mockDatePicker';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setPayCycleLength: jest.fn(),
  setPayday: jest.fn(),
  setSheet: jest.fn(),
};

// The pay cycle loads once the sheet opens; wait for the sheet and let that read settle.
async function openPayCycle(length = 14) {
  server.seed('/paycycle', { length, last_pay_date: '2026-06-06' });
  const state = { sheet: { mode: 'paycycle' }, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
  await screen.findByText('Weekly');
  await act(async () => {});
}

beforeEach(() => {
  fns.setPayCycleLength.mockClear();
  fns.setPayday.mockClear();
  fns.setSheet.mockClear();
  resetAuth();
});

// The selected row's label is drawn in accentSofter; the others in textMid.
const isTicked = (label: string) => styleOf(screen.getByText(label)).color === C.accentSofter;

// WHIT-671: length 14 is also the client default, so seed a non-default length to prove the
// server's reply reaches the sheet.
it('[A1] ticks the cycle length the server returns', async () => {
  await openPayCycle(30);
  await waitFor(() => expect(isTicked('Monthly')).toBe(true));
  expect(isTicked('Fortnightly')).toBe(false);
  expect(isTicked('Weekly')).toBe(false);
});

it('tapping a length calls setPayCycleLength with its day count', async () => {
  await openPayCycle(14);
  fireEvent.press(screen.getByText('Monthly'));
  expect(fns.setPayCycleLength).toHaveBeenCalledWith(30);
  fireEvent.press(screen.getByText('Weekly'));
  expect(fns.setPayCycleLength).toHaveBeenCalledWith(7);
});

it('picking a date calls setPayday with the ISO date (via the onChange event,date extraction)', async () => {
  await openPayCycle(14);
  // The mocked picker fires the real onChange({type:'set'}, Date(2026-06-20)).
  fireEvent.press(screen.getByTestId('mock-datepicker'));
  expect(fns.setPayday).toHaveBeenCalledWith('2026-06-20');
});

// [A1] A payday is never in the future: the sheet must cap the shared picker at today.
it('caps the payday picker at today', async () => {
  await openPayCycle(14);
  expect((renderedPickerProps().maximumDate as Date).toDateString()).toBe(new Date().toDateString());
});

// ABU-47: before the first read resolves the sheet must not draw the default cycle as if it
// were the user's, and a failed first read must offer Try again rather than the made-up cycle.
describe('first load', () => {
  const open = () => {
    const state = { sheet: { mode: 'paycycle' }, toast: null, ...fns } as unknown as AppContext;
    return openOverlays(state, (next) => { mockState = next; });
  };

  it('shows a spinner and no options while the pay cycle is still loading', async () => {
    const held = server.hold('/paycycle');
    await open();
    expect(screen.getByTestId('paycycle-loading')).toBeTruthy();
    expect(screen.queryByText('Weekly')).toBeNull();
    expect(screen.queryByTestId('mock-datepicker')).toBeNull();
    await act(async () => { held.release(); });
  });

  it('shows an error with Try again, and no options, when the first load fails', async () => {
    server.fail('/paycycle', 500);
    await open();
    await screen.findByTestId('paycycle-error');
    expect(screen.queryByText('Weekly')).toBeNull();
    expect(screen.queryByTestId('mock-datepicker')).toBeNull();
  });

  it('Try again loads the real pay cycle after a failed first load', async () => {
    server.once('GET', '/paycycle', { status: 500 });
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-06-06' });
    await open();
    await screen.findByTestId('paycycle-error');
    await act(async () => { fireEvent.press(screen.getByTestId('paycycle-retry')); });
    await waitFor(() => expect(isTicked('Monthly')).toBe(true));
  });
});
