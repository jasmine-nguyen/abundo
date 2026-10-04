// WHIT-706 QA: adversarial edges for the Budgets top card (hero). Real useBudgetsScreenData over
// the fake server; ../auth + expo-router mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { refreshInAct } from './support/renderWithQueries';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';
import { seedBudgets, renderBudgets } from './support/budgetsScreen';
import { COFFEE, SALARY } from './support/categories';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
const GROCERIES = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd1b9', recent: 12 };

beforeEach(() => {
  seedBudgets(server, { payCycle: { length: 30, last_pay_date: '2026-07-01', days_left: 4 } });
  resetRouter();
});

describe('Budgets top card — QA edges', () => {
  // [A1] (P0) under budget: the money-left amount itself is on the card next to its label
  it('[A1] under budget shows the left-to-spend amount (summed across rows) and the pill', async () => {
    server.seed('/categories', [COFFEE, GROCERIES]);
    server.seed('/budgets', {
      coffee: { target: 100, posted: 40, pending: 10 },
      groceries: { target: 250, posted: 40, pending: 0 },
    });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('$260')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.getByText('of $350')).toBeTruthy();
    expect(screen.getByText('$90 spent')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  // [A2] (P0) empty: no money figure or minus sign anywhere, days count kept, payday kept
  it('[A2] no budgets → no "$" figure, no pill, but the days count and next payday stay', async () => {
    pinToday(new Date('2026-09-18T10:00:00+10:00'));
    try {
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-01', days_left: 13 });
      server.seed('/budgets', {});
      renderBudgets();
      expect(await screen.findByText('Add a spending budget')).toBeTruthy();
      expect(screen.getByText('13')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(screen.getByText('Next payday 1 Oct')).toBeTruthy();
      expect(screen.queryAllByText(/\$/)).toHaveLength(0);
      expect(screen.queryAllByText(/−/)).toHaveLength(0);
      expect(screen.queryByText(/spent$/)).toBeNull();
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
    expect(screen.getByText("Solid = spent · faded = pending · line = today's pace")).toBeTruthy(); // caption back
    expect(screen.getByText('Add a budget')).toBeTruthy(); // dashed button back
  });

  // [A5] (P1) one labelled add button on the empty screen (sign-off Q1)
  it('[A5] the empty screen shows exactly one labelled add-budget button', async () => {
    server.seed('/budgets', {});
    renderBudgets();
    await screen.findByText('Add a spending budget');
    expect(screen.getAllByText(/add a spending budget|add a budget/i)).toHaveLength(1);
  });

  // [A6] (P1) income-only budgets have rows → not the first-time prompt
  it('[A6] income-only budgets do not show the first-time prompt', async () => {
    server.seed('/categories', [SALARY]);
    server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.queryByText('Add a spending budget')).toBeNull();
    expect(screen.getByText('Add a budget')).toBeTruthy();
  });

  // [A7] (P1) unparseable last_pay_date → no payday line, never "NaN" / "undefined"
  it('[A7] an unparseable last_pay_date hides the next payday line', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: 'garbage', days_left: 4 });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.queryByText(/Next payday/)).toBeNull();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  // [A8] (P0) the over sub-line follows the same -0.5 threshold as the label
  it('[A8] totRemain exactly -0.5 → no "Over by" line; -0.51 → "Over by $1"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.5 } });
    const first = renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.queryByText(/^Over by /)).toBeNull();
    expect(screen.queryAllByText(/−/)).toHaveLength(0);
    first.unmount();

    server.seed('/budgets', { coffee: { target: 100, posted: 100.51, pending: 0 } });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('Over by $1 · resets in 4 days')).toBeTruthy();
  });

  // [A9] (P1) a large deficit: comma-grouped in both the big number and the sub-line, no hyphen anywhere
  it('[A9] large deficit → "−$6,056" and "Over by $6,056", no hyphen-minus figure', async () => {
    server.seed('/budgets', { coffee: { target: 1000, posted: 7056, pending: 0 } });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('−$6,056')).toBeTruthy();
    expect(screen.getByText('Over by $6,056 · resets in 4 days')).toBeTruthy();
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
