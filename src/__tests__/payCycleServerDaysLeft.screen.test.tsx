// WHIT-341 GAP — the composites actually surface the SERVER days_left, not a locally
// recomputed countdown. Real ../api over the fake server, ../auth mocked; real
// QueryClientProvider. cycleClockView now CLAMPS to [0,length], so an out-of-range sentinel
// can't be used; instead SERVER_DAYS is an in-range value chosen to DIFFER from what the local
// cycleClock computes today, so a daysLeft of SERVER_DAYS can only have come through the server
// pass-through. (Reverting cycleClockView -> cycleClock in queries.ts yields the local clock's
// value, which differs, and fails these.)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { cycleClock } from '../payCycle';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';

import { usePayCycle, useBudgetsScreenData, useBudgetDetailScreenData } from '../queries';

const server = installFakeServer();

// An in-range server value (survives the clamp) chosen to DIFFER from the local clock's value
// for this cycle today — so a daysLeft of SERVER_DAYS proves the server pass-through, not the
// local clock. Computed against the same cycleClock the fallback would use, so it's exact.
const PAY = { length: 14, last_pay_date: '2020-01-01' };
const CLOCK_DAYS = cycleClock(PAY).daysLeft;        // in [1..14], run-date-dependent
const SERVER_DAYS = CLOCK_DAYS === 1 ? 2 : 1;       // a different, in-range value
const SERVER = { ...PAY, days_left: SERVER_DAYS };

beforeEach(() => {
  resetAuth();
  server.seed('/paycycle', SERVER);
});

it.each<[string, () => { isLoading: boolean; daysLeft: number; cycleLen: number }]>([
  ['usePayCycle', () => usePayCycle()],
  ['useBudgetsScreenData', () => useBudgetsScreenData()],
  ['useBudgetDetailScreenData', () => useBudgetDetailScreenData('coffee')],
])('%s surfaces the server days_left, not a locally computed countdown', async (_hook, hook) => {
  const { result } = renderHook(hook, { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.daysLeft).toBe(SERVER_DAYS);
  expect(result.current.cycleLen).toBe(14);
});
