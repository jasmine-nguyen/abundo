// WHIT-744 — Budgets tab rows go quiet: no pending line, no over/under plan line, and every
// "Includes …" note starts at the left, the same distance below the bar whether or not the row
// draws a pace tick. Real ../api over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C } from '../theme';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';
import { hostParent, styleOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// The band under a row's bar that holds the pace tick, or null when the row draws no tick.
function tickBand(row: ReactTestInstance) {
  const tick = row.findAll((n) => typeof n.type === 'string' && styleOf(n).backgroundColor === C.progressTick)[0];
  if (!tick) return null;
  return hostParent(tick);
}

// How far the note's top sits below the bar's bottom: the tick band (height + its top margin)
// when there is one, plus the margin above the note's wrapper.
function noteOffsetBelowBar(id: string) {
  const row = screen.getByTestId(`budget-row-${id}`);
  const band = tickBand(row);
  const bandSpace = band ? (styleOf(band).height ?? 0) + (styleOf(band).marginTop ?? 0) : 0;
  const wrapper = hostParent(screen.getByTestId(`budget-row-note-${id}`));
  return bandSpace + (styleOf(wrapper).marginTop ?? 0);
}

describe('WHIT-744 quiet Budgets tab rows', () => {
  it('rows show no pending or plan line, keep a short tick, and put every note the same distance below the bar', async () => {
    // Halfway through a 14-day cycle. Coffee: $80 spent ($10 pending) of $105 → under budget but
    // spending too fast, draws a tick, note "Includes $5 past leftovers". Groceries: $150 of $50
    // → over budget, no tick, note "Includes $50 past overspend".
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 70, pending: 10, rollover: true, carryover: 5 },
      groceries: { target: 100, posted: 150, pending: 0, rollover: true, carryover: -50 },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');

    expect(screen.queryByTestId('budget-row-pending-coffee')).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(screen.queryByText(/over plan/)).toBeNull();
    expect(screen.queryByText(/under plan/)).toBeNull();
    expect(within(screen.getByTestId('budget-row-coffee')).getByText('$25')).toBeTruthy();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $5 past leftovers');
    expect(screen.getByTestId('budget-row-note-groceries').props.children).toBe('Includes $50 past overspend');

    const coffeeBand = tickBand(screen.getByTestId('budget-row-coffee'));
    expect(coffeeBand).not.toBeNull();
    expect(StyleSheet.flatten(coffeeBand!.props.style).height).toBe(3);
    expect(tickBand(screen.getByTestId('budget-row-groceries'))).toBeNull();

    expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
    expect(noteOffsetBelowBar('coffee')).toBeGreaterThan(4);
  });
});
