// WHIT-734 — the setup the Budgets-tab screen suites share. Usage in a suite:
//
//   jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
//   useBudgetsSuiteReset();                     // + today pinned to Sat 3 Oct 2026, Melbourne
//   useBudgetsSuiteReset({ pinClock: false });  // real clock
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { beforeEach, afterEach, jest } from '@jest/globals';
import { resetRouter } from './routerMock';
import { resetAuth } from './authMock';
import { pinToday } from './clock';
import { realContextWith } from './contextMock';

// The real ../context, with the screen's delete/picker actions stubbed out.
export function budgetsContextMockModule() {
  return realContextWith(() => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }));
}

export function useBudgetsSuiteReset({ pinClock = true } = {}) {
  beforeEach(() => {
    resetRouter();
    resetAuth();
    if (pinClock) pinToday(new Date('2026-10-03T10:00:00+10:00'));
  });
  if (pinClock) afterEach(() => {
    jest.useRealTimers();
  });
}
