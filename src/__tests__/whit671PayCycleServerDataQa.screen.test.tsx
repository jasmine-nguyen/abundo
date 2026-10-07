// WHIT-671 QA — the pay-cycle pop-up shows the length the SERVER holds. The moved suites seed
// length 14, which is also the client's DEFAULT_PAY_CYCLE, so they pass even if the reply never
// reaches the sheet. These seed a non-default length and check which row is ticked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, act, waitFor } from '@testing-library/react-native';
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

const server = installFakeServer();
useTestQueryClient();

const PAY_CYCLE = '/paycycle';
const fns = { setPayCycleLength: jest.fn(), setPayday: jest.fn(), setSheet: jest.fn() };

const open = () => openOverlays(
  { sheet: { mode: 'paycycle' }, toast: null, ...fns } as unknown as AppContext,
  (next) => { mockState = next; },
);

// The selected row's label is drawn in accentSofter; the others in textMid.
const isTicked = (label: string) => styleOf(screen.getByText(label)).color === C.accentSofter;

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

describe('pay-cycle pop-up over the fake server', () => {
  // [A1] (P0) a monthly cycle on the server ticks Monthly, not the default Fortnightly.
  it('[A1] ticks the cycle length the server returns', async () => {
    server.seed(PAY_CYCLE, { length: 30, last_pay_date: '2026-06-06' });
    await open();
    await waitFor(() => expect(isTicked('Monthly')).toBe(true));
    expect(isTicked('Fortnightly')).toBe(false);
    expect(isTicked('Weekly')).toBe(false);
  });

  // [A2] (P1) while the pay cycle is still loading the sheet shows the default, then switches to
  // the server's length once the reply lands — the open sheet follows the cache, it isn't frozen.
  it('[A2] switches from the default to the server length once the reply arrives', async () => {
    server.seed(PAY_CYCLE, { length: 7, last_pay_date: '2026-06-06' });
    const held = server.hold(PAY_CYCLE);
    await open();
    expect(isTicked('Fortnightly')).toBe(true);
    expect(isTicked('Weekly')).toBe(false);

    await act(async () => { held.release(); });
    await waitFor(() => expect(isTicked('Weekly')).toBe(true));
    expect(isTicked('Fortnightly')).toBe(false);
    expect(server.sent('GET', PAY_CYCLE).length).toBeGreaterThan(0);
  });
});
