// WHIT-741 — Budgets tab polish at large text: no "·" on the row, the top card's labels and
// values in separate rows, both big numbers sized together, brighter notes, and a short tick band
// on every row (WHIT-744). Real ../api over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { C } from '../theme';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, showTwoRows, tickBandOf } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';
import { sharedHost, styleOf, textOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// The height of the band under a row's bar that holds the target tick.
const tickBandHeight = (rowTestID: string) => styleOf(tickBandOf(screen.getByTestId(rowTestID))!).height;

describe('WHIT-741 Budgets tab polish', () => {
  it('no line on the row starts with "·", and no row shows pending (WHIT-744)', async () => {
    await showTwoRows(server);

    expect(screen.queryByTestId('budget-row-pending-coffee')).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(textOf(screen.getByTestId('budget-row-coffee'))).not.toContain('·');
  });

  it('the top card puts Spent · Budget · Next payday labels in one row and their values in the next', async () => {
    await showTwoRows(server);

    const spent = screen.getByTestId('budgets-hero-spent');
    const payday = screen.getByTestId('budgets-hero-payday');
    expect(screen.getByTestId('budgets-hero-budget')).toBeTruthy();
    expect(spent.props.numberOfLines).toBe(1);
    expect(spent.props.adjustsFontSizeToFit).toBe(true);

    const valuesRow = sharedHost(spent, payday);
    expect(textOf(valuesRow)).not.toMatch(/Spent|Budget|Next payday/);

    const labelsRow = sharedHost(screen.getByText('Spent'), screen.getByText('Next payday'));
    expect(textOf(labelsRow)).not.toContain('$105');
  });

  it('both big numbers grow and shrink together: same size cap, and the days number never shrinks alone', async () => {
    await showTwoRows(server);

    const days = screen.getByText('7');
    const money = screen.getByText('$95');
    expect(typeof days.props.maxFontSizeMultiplier).toBe('number');
    expect(money.props.maxFontSizeMultiplier).toBe(days.props.maxFontSizeMultiplier);
    expect(days.props.adjustsFontSizeToFit).toBeFalsy();
    expect(StyleSheet.flatten(days.props.style).fontSize).toBe(44);
    expect(StyleSheet.flatten(money.props.style).fontSize).toBe(44);
  });

  it('every row\'s tick band is short (WHIT-744)', async () => {
    await showTwoRows(server);

    expect(screen.queryByText(/over plan/)).toBeNull();
    expect(tickBandHeight('budget-row-coffee')).toBe(3);
    expect(tickBandHeight('budget-row-groceries')).toBe(3);
  });

  it('the "Includes …" note is a little brighter than the dim sub-line', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 150, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    });
    await renderLoadedBudgetsWithQueries();

    expect(StyleSheet.flatten(screen.getByTestId('budget-row-note-coffee').props.style).color).toBe(C.textMid);
  });
});
