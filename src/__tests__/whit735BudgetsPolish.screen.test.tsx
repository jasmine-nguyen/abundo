// WHIT-735 — Budgets polish: the top card's amounts follow one rule (cents only when the amount has them),
// and a short "nothing spent yet" row uses the full row's 16pt top / 14pt bottom padding.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { showBudgets } from './support/budgetsScreen';
import { MINUS } from '../theme';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

// Coffee: 5948.92 posted + 187.76 pending = 6136.68 spent of 5685. Groceries: nothing spent of 100.
// Totals: spent $6,136.68, budget $5,785, over by $351.68.
const showOverWithSlimRow = () =>
  showBudgets(server, {
    coffee: { target: 5685, posted: 5948.92, pending: 187.76 },
    groceries: { target: 100, posted: 0, pending: 0 },
  });

describe('WHIT-735 Budgets polish', () => {
  it('the top card shows cents only when the amount has them: Spent $6,136.68 · Budget $5,785 · −$351.68', async () => {
    await showOverWithSlimRow();

    expect(screen.getByTestId('budgets-hero-spent')).toHaveTextContent('$6,136.68');
    expect(screen.getByTestId('budgets-hero-budget')).toHaveTextContent('$5,785');
    expect(screen.getByText(`${MINUS}$351.68`)).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
  });

  it('a short "nothing spent yet" row has the same top and bottom padding as a full row', async () => {
    await showOverWithSlimRow();
    await screen.findByText('Groceries');

    const full = StyleSheet.flatten(screen.getByTestId('budget-row-coffee').props.style);
    const slim = StyleSheet.flatten(screen.getByTestId('budget-row-groceries').props.style);

    expect({ top: slim.paddingTop, bottom: slim.paddingBottom }).toEqual({ top: 16, bottom: 14 });
    expect({ top: slim.paddingTop, bottom: slim.paddingBottom }).toEqual({ top: full.paddingTop, bottom: full.paddingBottom });
  });
});
