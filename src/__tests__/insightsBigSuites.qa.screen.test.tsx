// WHIT-687 slice 3 (qa) — gaps the moved InsightsScreen suite left open. Its "first load → no chart"
// and "sustained error → no chart" tests now run with earned = 0 (the breakdown never arrived), so
// the earned-vs-spent card is hidden whether or not the screen's spinner/error gate exists. These
// draw real server states where income IS present while the screen is loading or erroring.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireFocus, resetRouter } from './support/routerMock';
import { screen, fireEvent } from '@testing-library/react-native';
import { queryClient } from '../queryClient';
import { breakdownKey } from '../queryKeys';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient, settle, loaded } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, drawInsights, resetAi, refreshAiInsights } from './support/insightsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

const posted = (n: number) => ({ posted: n, pending: 0 });
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle' }];
const breakdownReads = () => server.sentUnder('GET', '/breakdown').length;

beforeEach(() => {
  resetRouter();
  resetAuth();
  resetAi();
});

describe('the earned-vs-spent card stays hidden over a real loading/error state with income present', () => {
  it('[A1] income arrived but categories are still loading → spinner, no card; card shows once they land', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 3000 }), categories: CATS });
    const held = server.hold('/categories');
    drawInsights();
    try {
      await loaded([...breakdownKey, 0]);
      expect(screen.getByTestId('insights-loading')).toBeTruthy();
      expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
    } finally {
      await refreshInAct(() => held.release());
    }
    await settle();
    expect(await screen.findByTestId('insights-earned-spent')).toBeTruthy(); // positive control
  });

  it('[A2] income arrived but the pay-cycle read failed → error card, no card', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 3000 }), categories: CATS });
    server.fail('/paycycle', 500);
    await renderInsights();
    expect(queryClient.getQueryState([...breakdownKey, 0])?.status).toBe('success');
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
  });

  it('[A3] spend + income arrived but categories never loaded → error card, no card and no donut', async () => {
    seedInsights(server, {
      breakdown: breakdownWire({ spend: { coffee: posted(40), __uncategorized__: posted(10) }, earned: 3000 }),
      categories: CATS,
    });
    server.fail('/categories', 500);
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
    expect(screen.queryByTestId('insights-donut')).toBeNull();
  });
});

describe('cycle switch reads each cycle from its own reply', () => {
  it('[A4] Last cycle shows its own total; This cycle comes back with its own total', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: posted(40) } }), categories: CATS });
    await renderInsights();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$40');

    server.once('GET', '/breakdown', { body: breakdownWire({ spend: { coffee: posted(125) } }) });
    fireEvent.press(screen.getByTestId('insights-cycle-prev'));
    await loaded([...breakdownKey, 1]);
    await settle();
    expect(screen.getByText('LAST PAY CYCLE')).toBeTruthy();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$125');
    expect(server.sentUnder('GET', '/breakdown').slice(-1)[0].path).toMatch(/&cycle=1$/);

    fireEvent.press(screen.getByTestId('insights-cycle-current'));
    await settle();
    expect(screen.getByText('THIS PAY CYCLE')).toBeTruthy();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$40');
  });
});

describe('focus refresh is staleness-gated', () => {
  it('[A5] a focus while the breakdown is still fresh sends no new read, but still refreshes AI', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: posted(40) } }), categories: CATS });
    await renderInsights();
    refreshAiInsights.mockClear();
    const before = breakdownReads();

    await refreshInAct(() => fireFocus());
    await settle();

    expect(breakdownReads()).toBe(before);
    expect(refreshAiInsights).toHaveBeenCalledTimes(1);
  });
});
