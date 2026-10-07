// WHIT-706 QA: adversarial edges for the Budgets top card (hero). Real useBudgetsScreenData over
// the fake server; ../auth + expo-router mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { refreshInAct } from './support/renderWithQueries';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';
import { seedBudgets, renderBudgets, renderLoadedBudgets, heroTotals } from './support/budgetsScreen';
import { COFFEE, GROCERIES_RECORD } from './support/categories';
import { MINUS } from '../theme';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
const GROCERIES = { ...GROCERIES_RECORD, color: '#7fd1b9' };

beforeEach(() => {
  seedBudgets(server, { payCycle: { length: 30, last_pay_date: '2026-07-01', days_left: 4 } });
  resetRouter();
});

describe('Budgets top card — QA edges', () => {
  // [A1] (P0) under budget: the money-left amount itself is on the card next to its label
  it('[A1] under budget shows the left-to-spend amount (summed across rows) and the spent line', async () => {
    server.seed('/categories', [COFFEE, GROCERIES]);
    server.seed('/budgets', {
      coffee: { target: 100, posted: 40, pending: 10 },
      groceries: { target: 250, posted: 40, pending: 0 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('$260')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$90', budget: '$350' });
    expect(screen.getByText('4')).toBeTruthy();
  });

  // [A2] (P0) empty: no money figure or minus sign anywhere, days count kept, payday kept
  it('[A2] no budgets → no "$" figure, no spent line, but the days count and next payday stay', async () => {
    pinToday(new Date('2026-09-18T10:00:00+10:00'));
    try {
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-01', days_left: 13 });
      server.seed('/budgets', {});
      renderBudgets();
      expect(await screen.findByText('Add a spending budget')).toBeTruthy();
      expect(screen.getByText('13')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(heroTotals()).toEqual({ spent: undefined, budget: undefined, payday: '1 Oct' });
      expect(screen.queryAllByText(/\$/)).toHaveLength(0);
      expect(screen.queryAllByText(/−/)).toHaveLength(0);
      expect(screen.queryByText("Today's pace")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  // [A3] (P1) empty + 1 day left → singular
  it('[A3] no budgets with 1 day left → "day left"', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 1 });
    server.seed('/budgets', {});
    renderBudgets();
    await screen.findByText('Add a spending budget');
    expect(screen.getByText('day left')).toBeTruthy();
    expect(screen.queryByText('days left')).toBeNull();
  });

  // [A4] (P0) once a first budget is added, the card switches to the normal money view
  it('[A4] empty → a budget appears on refetch → money view returns, first-time prompt goes', async () => {
    server.seed('/budgets', {});
    const { client } = renderBudgets();
    await screen.findByText('Add a spending budget');
    server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
    await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByText('Add a spending budget')).toBeNull();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Add a budget')).toBeNull(); // WHIT-814: no dashed row; the header "+" adds
  });

  // [A7] (P1) unparseable last_pay_date → no payday line, never "NaN" / "undefined"
  it('[A7] an unparseable last_pay_date hides the next payday line', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: 'garbage', days_left: 4 });
    await renderLoadedBudgets();
    expect(screen.queryByTestId('budgets-hero-payday')).toBeNull();
    expect(screen.queryByText('Next payday')).toBeNull();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  // [A8] (P0) "Over budget" follows the 1-cent threshold (WHIT-716)
  it('[A8] under a cent over → "Left to spend"; a cent over → "−$0.01" and "Over budget"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.004 } });
    const first = await renderLoadedBudgets();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryAllByText(/−/)).toHaveLength(0);
    first.unmount();

    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.01 } });
    await renderLoadedBudgets();
    expect(screen.getByText(`${MINUS}$0.01`)).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
  });

  // [A9] (P1) a large deficit: comma-grouped in the big number, said once, no hyphen anywhere
  it('[A9] large deficit → "−$6,056" once, no hyphen-minus figure', async () => {
    server.seed('/budgets', { coffee: { target: 1000, posted: 7056, pending: 0 } });
    await renderLoadedBudgets();
    expect(screen.getByText(`${MINUS}$6,056`)).toBeTruthy();
    expect(screen.queryByText(/Over by/)).toBeNull();
    expect(screen.queryAllByText(/-\$/)).toHaveLength(0);
  });

  // [A10] (P1) the empty-state button press does not double-navigate
  it('[A10] tapping "Add a spending budget" pushes the picker exactly once', async () => {
    server.seed('/budgets', {});
    renderBudgets();
    fireEvent.press(await screen.findByTestId('budgets-hero-add'));
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
  });
});
