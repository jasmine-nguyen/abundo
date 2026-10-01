// WHIT-687 slice 2 QA — the Insights tab over the fake server, checks the moved suites leave open:
// pending income counts toward earned, an income-only cycle still gets the card, a $0-net source is
// dropped, a still-loading taxonomy never shows a false $0, and the Retry button really re-reads.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { queryClient } from '../queryClient';
import { breakdownKey } from '../queries';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, drawInsights, resetAi } from './support/insightsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

const server = installFakeServer();
useTestQueryClient();

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'briefcase', bucket: 'Income', recent: 0, colorSlot: 2 },
];

beforeEach(() => {
  resetAuth();
  resetAi();
});

describe('earned vs spent reads the real __earned__ bucket', () => {
  // [A1] posted + pending both count toward earned.
  it('[A1] pending income counts: earned 1,000 posted + 500 pending vs 2,000 spend → −$500 deficit', async () => {
    seedInsights(server, {
      breakdown: { coffee: { posted: 2000, pending: 0 }, __earned__: { posted: 1000, pending: 500 } },
      categories: CATS,
    });
    await renderInsights();
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$500 deficit');
  });

  // [A2] income-only cycle: the card still shows, driven only by __earned__.
  it('[A2] income with no spend → the card shows a +$3,000 surplus', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 3000, income: { salary: { posted: 3000, pending: 0 } } }), categories: CATS });
    await renderInsights();
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$3,000 surplus');
  });
});

describe('Earning tab drops a zero-net source', () => {
  // [A4] a source whose posted + pending nets to $0 gets no row.
  it('[A4] a $0-net bonus is not listed; the salary is', async () => {
    seedInsights(server, {
      breakdown: breakdownWire({
        spend: { coffee: { posted: 30, pending: 0 } },
        earned: 3000,
        income: { salary: { posted: 3000, pending: 0 }, bonus: { posted: 200, pending: -200 } },
      }),
      categories: [...CATS, { id: 'bonus', name: 'Bonus', icon: 'gift', bucket: 'Income', recent: 0 }],
    });
    await renderInsights();
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Salary')).toBeTruthy();
    expect(screen.queryByText('Bonus')).toBeNull();
  });
});

describe('a still-loading taxonomy never shows a false $0', () => {
  // [A5] breakdown is in, categories still on the way → spinner, not "$0 across 0 categories".
  it('[A5] categories held → hero reads Loading…, then the real total once they land', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 40, pending: 0 } } }), categories: CATS });
    const held = server.hold('/categories');
    drawInsights();
    try {
      // Only categories are outstanding: the breakdown and pay cycle have both landed.
      await waitFor(() => expect(queryClient.isFetching()).toBe(1));
      await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(1));
      expect(queryClient.getQueryCache().findAll({ queryKey: breakdownKey })[0]?.state.status).toBe('success');
      expect(screen.getByText('Loading…')).toBeTruthy();
      expect(screen.queryByText('$0')).toBeNull();
      expect(screen.queryByTestId('insights-hero-total')).toBeNull();
    } finally {
      held.release();
    }
    expect((await screen.findByTestId('insights-hero-total')).props.children).toBe('$40');
  });
});

describe('Retry after a first-load failure', () => {
  // [A6] the error card's Retry re-reads the breakdown and the rows come back.
  it('[A6] breakdown fails once → error card → tap Retry → rows and total show', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 25, pending: 0 } } }), categories: CATS });
    server.once('GET', '/breakdown', { status: 500 });
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();

    await refreshInAct(() => fireEvent.press(screen.getByTestId('insights-retry')));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('insights-error')).toBeNull();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$25');
  });
});
