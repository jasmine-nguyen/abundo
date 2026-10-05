// WHIT-744 QA — the edges the proof test leaves: notes still line up at very large text (WHIT-743
// layout kept), a row spent exactly to its budget (no tick, not over) lines up with a ticked spread
// row, and the bar keeps its lighter pending part now the pending line is gone.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { noteOffsetBelowBar, renderLoadedBudgetsWithQueries, tickBandOf } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';
import { styleOf } from './support/layout';

let mockLarge = false;
jest.mock('../hooks/useLargeText', () =>
  require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockLarge = false;
  resetRouter();
  resetAuth();
});

// Halfway through a 14-day cycle. Coffee: $80 ($10 pending) of $105 → ticked, "Includes $5 past
// leftovers". Groceries: $150 of $50 → over, no tick, "Includes $50 past overspend".
const showTickAndOver = async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 70, pending: 10, rollover: true, carryover: 5 },
    groceries: { target: 100, posted: 150, pending: 0, rollover: true, carryover: -50 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');
};

describe('WHIT-744 QA — quiet Budgets rows', () => {
  // [A1] (P0)
  it('[A1] at very large text, a ticked and an unticked row still put the note the same distance below the bar', async () => {
    mockLarge = true;
    await showTickAndOver();
    expect(tickBandOf(screen.getByTestId('budget-row-coffee'))).not.toBeNull();
    expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).toBeNull();
    expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
    expect(screen.queryByText(/pending|over plan|under plan/)).toBeNull();
  });

  // [A2] (P1)
  it('[A2] a row spent exactly to its budget (no tick, not over) lines up with a ticked spread-bills row', async () => {
    // Coffee: $105 of $105 ($100 + $5 leftovers) → $0 left, not over, no tick. Groceries: $25 of $300
    // with a $200 spread → ticked, "Includes spread bills".
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 105, pending: 0, rollover: true, carryover: 5 },
      groceries: { target: 100, posted: 25, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $5 past leftovers');
    expect(screen.getByTestId('budget-row-note-groceries').props.children).toBe('Includes spread bills');
    expect(tickBandOf(screen.getByTestId('budget-row-coffee'))).toBeNull();
    expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).not.toBeNull();
    expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
  });

  // [A3] (P1)
  it('[A3] the bar still draws the lighter pending part after the pending line is gone', async () => {
    await showTickAndOver();
    const row = screen.getByTestId('budget-row-coffee');
    // Posted $70 and pending $10 of $105: the pending segment starts where posted ends and has width.
    const segments = row.findAll((n) => typeof n.type === 'string' && typeof styleOf(n).left === 'string' && typeof styleOf(n).width === 'string');
    expect(segments).toHaveLength(1);
    expect(parseFloat(String(styleOf(segments[0]).width))).toBeGreaterThan(5);
  });
});
