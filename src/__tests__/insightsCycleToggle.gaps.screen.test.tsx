// WHIT-68 — Insights "This cycle / Last cycle" toggle: adversarial GAPS (client PR 2/2).
// Independent of the implementer's insightsBreakdownQuery tests (which already lock the
// relabel, the cache-first toggle-BACK with no cycle-0 refetch, and the EMPTY-coach
// reappearance). This file adds only what those miss:
//   [A6] accessibilityState.selected tracks the active segment on BOTH segments (a11y lock)
//   [A7] a past-cycle read that FAILS shows the inline error + Retry, and Retry refetches
//        cycle 1 (the cycle-keyed error path, end to end)
// WHIT-691: runs on the shared Insights kit (support/insightsScreen.tsx) — real ../api over the
// fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedInsights, renderInsights, resetAi } from './support/insightsScreen';
import { COFFEE } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

const CATS = [{ ...COFFEE }];
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

beforeEach(() => {
  resetAuth();
  resetAi();
  seedInsights(server, { breakdown: BREAKDOWN, categories: CATS });
});

// [A6] a11y lock — VoiceOver reads the active segment. Asserts BOTH segments so a
// "both selected" / "hardcoded true" regression bites (the implementer's tests never
// read accessibilityState).
it('[A6] segmented control accessibilityState.selected tracks the active segment (both segments)', async () => {
  await renderInsights();
  await screen.findByText('Cafes & Coffee');

  // on mount: current selected, prev NOT
  expect(screen.getByTestId('insights-cycle-current').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('insights-cycle-prev').props.accessibilityState.selected).toBe(false);

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  await screen.findByText('LAST PAY CYCLE');

  // after tapping "Last cycle": selection flips — prev selected, current NOT
  expect(screen.getByTestId('insights-cycle-prev').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('insights-cycle-current').props.accessibilityState.selected).toBe(false);
});

// [A7] the cycle-keyed error path end to end: cycle 0 loads fine, switching to a past
// cycle whose read FAILS must show the inline error + Retry (not a stale cycle-0 hero or
// a confident $0), and Retry must refetch cycle 1 specifically.
it('[A7] a past-cycle read that FAILS shows inline error + Retry; Retry refetches cycle 1', async () => {
  await renderInsights();
  await screen.findByText('Cafes & Coffee');

  // Cycle 0 is cached now, so from here only the cycle-1 read reaches the server — and it fails.
  server.fail('/breakdown', 503);
  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  expect(await screen.findByTestId('insights-error')).toBeTruthy();
  expect(screen.queryByText('$0')).toBeNull();               // no confident zero over a past-cycle error
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();   // no stale cycle-0 rows bleeding through

  // Retry — cycle 1 now succeeds with its own data (a queued reply goes out ahead of the failure).
  server.once('GET', '/breakdown', { body: { coffee: { posted: 5, pending: 0 } } });
  fireEvent.press(screen.getByTestId('insights-retry'));

  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('LAST PAY CYCLE')).toBeTruthy();    // still on the past cycle after recovery
  expect(server.sentUnder('GET', '/breakdown').slice(-1)[0].path).toBe('/breakdown?cycle=1'); // the refetch was for cycle 1
});
