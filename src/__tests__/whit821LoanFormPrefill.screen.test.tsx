// WHIT-821 — the Loan details form pre-fills Scheduled repayment from the last repayment
// (GET /repayment) when none is saved; a saved value always wins; a failed repayment read
// doesn't block the form; and placeholders are neutral examples, not a real user's figures.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { EMPTY_LOAN_FACTS, LOAN_FACTS, NO_REPAYMENT } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, drawHeld, refreshInAct, releaseAndSettle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { LOAN_FORM_PLACEHOLDERS } from './support/loanForm';

let mockState: Partial<AppContext>;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';

const server = installFakeServer();
useTestQueryClient();

const LAST_REPAYMENT = { amount: 3667, date: '2026-07-01', principal: 1200, interest: 2467 };
const PREFILL_HINT = /From your last repayment/;

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockState = { saveLoanFacts: jest.fn() as AppContext['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'] };
});

it.each([
  ['no saved repayment + a last repayment → pre-filled with a hint', EMPTY_LOAN_FACTS, LAST_REPAYMENT, '3667', true],
  ['a saved repayment wins over the last repayment, no hint', LOAN_FACTS, LAST_REPAYMENT, '1240', false],
  ['no saved repayment + nothing on record → empty, no hint', EMPTY_LOAN_FACTS, NO_REPAYMENT, '', false],
  ['no saved repayment + the repayment read fails → form still opens, empty', EMPTY_LOAN_FACTS, 'fail', '', false],
] as const)('Loan form: %s', async (_name, loanFacts, repayment, expected, hinted) => {
  server.seed('/loanfacts', loanFacts);
  if (repayment === 'fail') server.fail('/repayment', 500);
  else server.seed('/repayment', repayment);
  await renderWithQueries(<Loan />);

  expect(screen.getByText('Save loan details')).toBeTruthy();
  const scheduled = screen.getByPlaceholderText(LOAN_FORM_PLACEHOLDERS.base);
  expect(scheduled.props.value).toBe(expected);
  expect(screen.queryByText(PREFILL_HINT) !== null).toBe(hinted);

  for (const personal of ['3667', '600000', '770000', '5.74']) {
    expect(screen.queryByPlaceholderText(new RegExp(personal.replace('.', '\\.')))).toBeNull();
  }
});

// [A5] The form waits for the last repayment before it opens, so a slow repayment read can't
// leave Scheduled repayment empty (its first value is only read once, when the form opens).
it('Loan form: waits for a slow repayment read, then opens pre-filled', async () => {
  server.seed('/loanfacts', EMPTY_LOAN_FACTS);
  server.seed('/repayment', LAST_REPAYMENT);
  const held = server.hold('/repayment');
  drawHeld(<Loan />);
  await refreshInAct(() => undefined);
  expect(screen.queryByText('Save loan details')).toBeNull();

  await releaseAndSettle(held);
  expect(screen.getByPlaceholderText(LOAN_FORM_PLACEHOLDERS.base).props.value).toBe('3667');
});
