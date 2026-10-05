// WHIT-685 slice 1 — acceptance: the shared Goals test kit fills the fake server from the app-shaped
// values the old makeGoalData fakes used, the real mortgage screen reads them through the real screen
// data code, and the 8 mortgage/milestone tests stop faking that code.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { seedGoal } from './support/goalsScreen';
import {  } from './support/routerMock';
import type { MilestoneRecord } from '../api';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as object;
  return { ...actual, useAppContext: () => ({}) };
});
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start', targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

function MortgageScreen() {
  const Mortgage = require('../../app/mortgage').default;
  return <Mortgage />;
}

describe('the mortgage screen drawn over the fake server with the shared Goals kit', () => {
  it('shows the seeded balance owing and the saved sprint plan through the real screen data code', async () => {
    seedGoal(server, {
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null, payoffGoalDate: null },
      homeLoan: { balance: 250000, asOf: '2026-07-04T00:24:37.614Z' },
      milestones: SAVED_PLAN,
    });

    await renderWithQueries(<MortgageScreen />);

    expect(await screen.findByText('$250,000')).toBeTruthy();
    expect(screen.getByText('1 of 3 sprints reached')).toBeTruthy();
    expect(screen.getByText('Next: under $200,000')).toBeTruthy();
    expect(server.sent('GET', '/homeloan')).toHaveLength(1);
    expect(server.sent('GET', '/milestones')).toHaveLength(1);
  });
});

// Built from pieces so this file never matches its own scan.
const SCREEN_DATA_MOCK = new RegExp(String.raw`^\s*jest\.(mock|doMock)\(\s*['"](\.\./)+(src/)?` + 'quer' + `ies['"]`, 'm');
const AUTH_MOCK_MODULE = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)/;
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

const SLICE_FILES = [
  'equityCardDepositTarget.screen.test.tsx',
  'goalErrorStates.a11y.screen.test.tsx',
  'goals.paydown.screen.test.tsx',
  'goalTooAggressive.screen.test.tsx',
  'mortgage.screen.test.tsx',
  'repayment.edges.screen.test.tsx',
  'repayment.errorBoundary.screen.test.tsx',
  'milestone.screen.test.tsx',
];

function allowedBlock(): string {
  const text = read('noQueriesMock.logic.test.ts');
  const start = text.indexOf('const ALLOWED');
  return text.slice(start, text.indexOf(']);', start));
}

describe('the 8 mortgage and milestone tests use the real screen data code', () => {
  it('none fakes the screen data code; each draws over the fake server, is off the allow-list and pinned in the check-count list', () => {
    const allowed = allowedBlock();
    const baselines = read('noAutoMockApi.logic.test.ts');

    const problems = SLICE_FILES.flatMap((file) => {
      const text = read(file);
      const found: string[] = [];
      if (SCREEN_DATA_MOCK.test(text)) found.push(`${file}: fakes the screen data code`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!AUTH_MOCK_MODULE.test(text)) found.push(`${file}: does not use the shared authMockModule()`);
      if (allowed.includes(`'${file}'`)) found.push(`${file}: still on the noQueriesMock ALLOWED list`);
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi check-count list`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
