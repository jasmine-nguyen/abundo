// WHIT-820 — a repayment push opens Home loan. A repayment this phone hasn't shown yet gets a
// "Just landed" card at the top plus the celebration banner, and the plain "Last repayment" row is
// hidden for that visit. The phone remembers it, so the next visit shows the plain row again; a
// repayment already shown never celebrates. Real screen data code over the fake server; reduce
// motion on so the banner shows without the confetti animation.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { savedRepaymentNote, repaymentSeenEarlier } from './support/celebrationSnapshot';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

const REPAYMENT = { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 };

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 5)); // 4 days after the repayment
  seedGoal(server, { repayment: REPAYMENT, milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: null } });
});
afterEach(() => { jest.useRealTimers(); });

const plainRow = () => screen.queryByText(/^Last repayment · /);

it('a new repayment lands as a "Just landed" card with a banner, then settles back to the plain row', async () => {
  const first = await renderWithQueries(<Mortgage />);

  const card = await screen.findByTestId('repayment-landed');
  expect(card).toHaveTextContent(/JUST LANDED/);
  expect(card).toHaveTextContent(/\$1,208 off your loan/);
  expect(card).toHaveTextContent(/Next: Midway · \$50,000 to go/);
  expect(screen.getByTestId('checkpoint-celebration-label')).toHaveTextContent('Repayment landed 🎉');
  expect(plainRow()).toBeNull();
  expect(await savedRepaymentNote()).toBe('2026-07-01@1440');

  first.unmount();
  await renderWithQueries(<Mortgage />);
  expect(screen.queryByTestId('repayment-landed')).toBeNull();
  expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  expect(plainRow()).toBeTruthy();
});

it('a repayment the phone has already shown stays a plain row, with no banner', async () => {
  await repaymentSeenEarlier('2026-07-01@1440');
  await renderWithQueries(<Mortgage />);
  expect(plainRow()).toBeTruthy();
  expect(screen.queryByTestId('repayment-landed')).toBeNull();
  expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
});

// [A1] [A2] QA — with no card, the note is saved quietly (first run, old repayment) or left alone
// (an older repayment never overwrites a newer note).
it.each<[string, Date, string | null, string]>([
  ['first run, repayment 8 days old → saved quietly', new Date(2026, 6, 9), null, '2026-07-01@1440'],
  ['a newer note is already saved → left alone', new Date(2026, 6, 5), '2026-07-15@1500', '2026-07-15@1500'],
])('%s', async (_case, today, earlier, expectedNote) => {
  pinToday(today);
  if (earlier) await repaymentSeenEarlier(earlier);
  await renderWithQueries(<Mortgage />);
  expect(plainRow()).toBeTruthy();
  expect(screen.queryByTestId('repayment-landed')).toBeNull();
  expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  expect(await savedRepaymentNote()).toBe(expectedNote);
});

// [A3] QA — a repayment newer than the one shown last time celebrates and replaces the note.
it('a repayment newer than the saved note celebrates and replaces the note', async () => {
  await repaymentSeenEarlier('2026-06-17@1440');
  await renderWithQueries(<Mortgage />);
  expect(await screen.findByTestId('repayment-landed')).toHaveTextContent(/\$1,208 off your loan/);
  expect(screen.getByTestId('checkpoint-celebration-label')).toHaveTextContent('Repayment landed 🎉');
  expect(await savedRepaymentNote()).toBe('2026-07-01@1440');
});

// [A4] QA — a failed repayment read never celebrates or touches the note; the Retry that loads it does.
it('a failed repayment read leaves the note alone; the retry that loads it celebrates', async () => {
  server.once('GET', '/repayment', { status: 500 });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByTestId('repayment-landed')).toBeNull();
  expect(await savedRepaymentNote()).toBeNull();

  await refreshInAct(() => fireEvent.press(screen.getByText('Retry')));
  expect(await screen.findByTestId('repayment-landed')).toBeTruthy();
  expect(await savedRepaymentNote()).toBe('2026-07-01@1440');
});
