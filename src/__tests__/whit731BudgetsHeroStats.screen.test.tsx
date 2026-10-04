// WHIT-731 — Budgets top card: the money number is about two-thirds the height of days-left (cents
// kept), and one full-width row of three labelled values replaces the two small lines:
// Spent · Budget · Next payday.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { showBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

const STAT_IDS = ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday'];

const showOverBudget = () =>
  showBudgets(server, { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } }, { categories: [COFFEE], daysLeft: 22 });

function statIdsInOrder() {
  return screen.UNSAFE_root
    .findAll((node) => typeof node.type === 'string' && STAT_IDS.includes(node.props.testID))
    .map((node) => node.props.testID);
}

beforeEach(() => resetRouter());

describe('WHIT-731 Budgets top card: Spent · Budget · Next payday row', () => {
  it('over budget → money keeps cents, and the row shows Spent $6,137 · Budget $5,785 · Next payday, with no pending on the card', async () => {
    await showOverBudget();

    // 5948.92 posted + 187.76 pending − 5785 budget = 351.68 over.
    expect(screen.getByText('−$351.68')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();

    expect(screen.getByTestId('budgets-hero-spent')).toHaveTextContent('$6,137');
    expect(screen.getByTestId('budgets-hero-budget')).toHaveTextContent('$5,785');
    const payday = screen.getByTestId('budgets-hero-payday');
    expect(payday).toHaveTextContent(/^\d{1,2} [A-Z][a-z]{2}$/);

    expect(screen.getByText('Spent')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.getByText('Next payday')).toBeTruthy();
    expect(screen.queryByText(/ spent$/)).toBeNull();

    expect(statIdsInOrder()).toEqual(STAT_IDS);

    // Pending stays on the coffee row only.
    expect(screen.getAllByText(/\$187\.76 pending/)).toHaveLength(1);
  });

  it('the money number is about two-thirds the height of the days-left number', async () => {
    await showOverBudget();

    const daysLeftSize = StyleSheet.flatten(screen.getByText('22').props.style).fontSize as number;
    const moneySize = StyleSheet.flatten(screen.getByText('−$351.68').props.style).fontSize as number;

    expect(moneySize / daysLeftSize).toBeGreaterThanOrEqual(0.6);
    expect(moneySize / daysLeftSize).toBeLessThanOrEqual(0.75);
  });
});
