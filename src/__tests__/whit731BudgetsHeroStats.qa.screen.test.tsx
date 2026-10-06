// WHIT-731 QA — adversarial edges of the Spent · Budget · Next payday row: the totals survive a
// missing payday, and huge totals stay on one line instead of wrapping.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { seedBudgets, renderLoadedBudgets, showBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-731 QA — the Spent · Budget · Next payday row', () => {
  // [A1] (P1) unparseable payday → Spent and Budget still show, the payday cell and its label don't
  it('[A1] no payday date → Spent and Budget still show, no "Next payday" cell', async () => {
    seedBudgets(server, { payCycle: { length: 30, last_pay_date: 'garbage', days_left: 4 } });
    await renderLoadedBudgets();
    expect(heroTotals()).toEqual({ spent: '$50', budget: '$100', payday: undefined });
    expect(screen.getByText('Spent')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.queryByText('Next payday')).toBeNull();
  });

  // [A2] (P2) huge totals stay one line and shrink to fit rather than wrap
  it('[A2] million-dollar totals → each value is one line that shrinks to fit', async () => {
    await showBudgets(server, { coffee: { target: 1234567, posted: 2345678, pending: 0 } }, { categories: [COFFEE] });
    expect(heroTotals()).toMatchObject({ spent: '$2,345,678', budget: '$1,234,567' });
    for (const id of ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday']) {
      const value = screen.getByTestId(id);
      expect(value.props.numberOfLines).toBe(1);
      expect(value.props.adjustsFontSizeToFit).toBe(true);
    }
  });
});
