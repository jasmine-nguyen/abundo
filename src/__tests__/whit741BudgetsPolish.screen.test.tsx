// WHIT-741 — Budgets tab polish at large text: pending on its own line, the top card's labels and
// values in separate rows, both big numbers sized together, brighter notes, and no empty tick band
// under a bar with nothing below it. Real ../api over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C } from '../theme';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// Halfway through a 14-day cycle (7 days left), so a $100 budget's pace target is $50.
// Coffee: $80 spent ($10 pending) → behind pace, has a pace line. Groceries: $25 spent, nothing
// pending → no pace line, no note. Totals: spent $105 of $200 → $95 left.
const showTwoRows = async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 70, pending: 10 },
    groceries: { target: 100, posted: 25, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

// The nearest host View above `node` that also holds `other`.
function sharedRow(node: ReactTestInstance, other: ReactTestInstance) {
  for (let host = node.parent; host; host = host.parent) {
    if (typeof host.type !== 'string') continue;
    if (host.findAll((n) => n === other).length > 0) return host;
  }
  throw new Error('no shared ancestor');
}

// The height of the band under a row's bar that holds the target tick.
function tickBandHeight(rowTestID: string) {
  const row = screen.getByTestId(rowTestID);
  const tick = row.findAll((n) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.backgroundColor === C.progressTick)[0];
  let band = tick.parent!;
  while (typeof band.type !== 'string') band = band.parent!;
  return StyleSheet.flatten(band.props.style).height;
}

describe('WHIT-741 Budgets tab polish', () => {
  it('pending shows on its own line under "$X of $Y", and no line starts with "·"', async () => {
    await showTwoRows();

    const pending = screen.getByTestId('budget-row-pending-coffee');
    expect(textOf(pending).replace(/ /g, ' ')).toBe('$10 pending');
    expect(screen.queryByTestId('budget-row-pending-groceries')).toBeNull();
    expect(textOf(screen.getByTestId('budget-row-coffee'))).not.toContain('·');
  });

  it('the top card puts Spent · Budget · Next payday labels in one row and their values in the next', async () => {
    await showTwoRows();

    const spent = screen.getByTestId('budgets-hero-spent');
    const payday = screen.getByTestId('budgets-hero-payday');
    expect(screen.getByTestId('budgets-hero-budget')).toBeTruthy();
    expect(spent.props.numberOfLines).toBe(1);
    expect(spent.props.adjustsFontSizeToFit).toBe(true);

    const valuesRow = sharedRow(spent, payday);
    expect(textOf(valuesRow)).not.toMatch(/Spent|Budget|Next payday/);

    const labelsRow = sharedRow(screen.getByText('Spent'), screen.getByText('Next payday'));
    expect(textOf(labelsRow)).not.toContain('$105');
  });

  it('both big numbers grow and shrink together: same size cap, and the days number never shrinks alone', async () => {
    await showTwoRows();

    const days = screen.getByText('7');
    const money = screen.getByText('$95');
    expect(typeof days.props.maxFontSizeMultiplier).toBe('number');
    expect(money.props.maxFontSizeMultiplier).toBe(days.props.maxFontSizeMultiplier);
    expect(days.props.adjustsFontSizeToFit).toBeFalsy();
    expect(StyleSheet.flatten(days.props.style).fontSize).toBe(44);
    expect(StyleSheet.flatten(money.props.style).fontSize).toBe(44);
  });

  it('a row with nothing under its bar has no empty 18pt tick band; a row with a pace line keeps it', async () => {
    await showTwoRows();

    expect(screen.getByText(/over plan/)).toBeTruthy();
    expect(tickBandHeight('budget-row-coffee')).toBe(18);
    expect(tickBandHeight('budget-row-groceries')).toBeLessThan(18);
  });

  it('the "Includes …" note is a little brighter than the dim sub-line', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 150, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    });
    await renderLoadedBudgetsWithQueries();

    expect(StyleSheet.flatten(screen.getByTestId('budget-row-note-coffee').props.style).color).toBe(C.textMid);
  });
});
