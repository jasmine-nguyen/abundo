// WHIT-672 — the Loan details form opened the way the app opens it: the saved loan facts have
// already loaded from the (fake) server, then the form fills itself from them once.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFactsInput } from '../context';

let mockState: Pick<AppContext, 'saveLoanFacts' | 'showToast'>;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderLoaded } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

const SAVED = {
  original: 600000, homeValue: 770000, lvr: 0.5, ratePct: 5.74,
  baseRepay: 1240, extra: 200, payoffGoalDate: null, depositTarget: null,
};

beforeEach(() => {
  resetRouter();
  resetAuth();
});

describe('loan form over the fake server', () => {
  it('user sees their saved loan facts prefilled and can save them unchanged', async () => {
    server.seed('/loanfacts', SAVED);
    const saveLoanFacts = jest.fn(async (_facts: LoanFactsInput) => true);
    mockState = { saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'] };

    await renderLoaded(<Loan />);

    expect(screen.getByDisplayValue('600000')).toBeTruthy();
    expect(screen.getByDisplayValue('770000')).toBeTruthy();
    expect(screen.getByDisplayValue('50')).toBeTruthy();
    expect(screen.getByDisplayValue('5.74')).toBeTruthy();
    expect(screen.getByDisplayValue('1240')).toBeTruthy();
    expect(screen.getByDisplayValue('200')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

    expect(saveLoanFacts).toHaveBeenCalledWith(SAVED);
    expect(routerSpies.back).toHaveBeenCalled();
  });
});
