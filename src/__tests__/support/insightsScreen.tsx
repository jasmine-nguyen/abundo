// WHIT-687 — draw the real Insights tab over the fake server. The screen data code (../queries)
// runs for real; only the AI coach's useAiInsights() is a stand-in a test can set. Usage in a suite
// (the jest.mock calls must stay in the test file, for hoisting):
//
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
//   jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
//   const server = installFakeServer();
//   useTestQueryClient();
//   beforeEach(() => { resetAuth(); resetAi(); });
//   seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 40, pending: 0 } } }), categories });
//   await renderInsights();
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import type { useAiInsights } from '../../hooks/useAiInsights';
import type { installFakeServer } from './fakeServer';
import { renderWithQueries, WithQueries } from './renderWithQueries';

type AiInsightsHook = ReturnType<typeof useAiInsights>;
type AiSlice = Omit<AiInsightsHook, 'refresh'> & { refresh: () => Promise<unknown> };
type Spend = Record<string, { posted: number; pending: number }>;

export const refreshAiInsights = jest.fn(async () => {});
export const generateAiInsights = jest.fn<AiInsightsHook['generate']>(async () => {});

const AI_DEFAULTS = { insights: null, isLoading: false, isError: false };
let ai: AiSlice = { ...AI_DEFAULTS, refresh: refreshAiInsights, generate: generateAiInsights };

export function setAi(over: Partial<AiSlice>) {
  ai = { ...ai, ...over };
}

export function resetAi() {
  refreshAiInsights.mockClear();
  generateAiInsights.mockClear();
  ai = { ...AI_DEFAULTS, refresh: refreshAiInsights, generate: generateAiInsights };
}

// The jest.mock('../hooks/useAiInsights') factory: useAiInsights reads the AI slice set above.
export function useAiInsightsMockModule() {
  return { useAiInsights: () => ai };
}

// The /breakdown reply: spend rows plus the __earned__ / __income__ / __rollup__ extras.
export function breakdownWire({ spend = {}, earned, income, rollup }: { spend?: Spend; earned?: number; income?: Spend; rollup?: unknown }) {
  return {
    ...spend,
    ...(earned === undefined ? {} : { __earned__: { posted: earned, pending: 0 } }),
    ...(income === undefined ? {} : { __income__: income }),
    ...(rollup === undefined ? {} : { __rollup__: rollup }),
  };
}

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };

export function seedInsights(
  server: ReturnType<typeof installFakeServer>,
  { breakdown, categories, payCycle = PAY_CYCLE }: { breakdown: unknown; categories: unknown[]; payCycle?: unknown },
) {
  server.seed('/breakdown', breakdown);
  server.seed('/categories', categories);
  server.seed('/paycycle', payCycle);
}

// Required lazily: importing the screen at load time would re-enter the ../hooks/useAiInsights mock factory.
function InsightsTab() {
  const Insights = require('../../../app/(tabs)/insights').default;
  return <Insights />;
}

/** Draw the tab and wait until the first reads have settled. */
export function renderInsights() {
  return renderWithQueries(<InsightsTab />);
}

/** Draw the tab without waiting, for held / still-loading replies. */
export function drawInsights() {
  return render(<WithQueries><InsightsTab /></WithQueries>);
}

/** Redraw an already-drawn tab, e.g. after setAi() changed the AI slice. */
export function redrawInsights(view: ReturnType<typeof render>) {
  view.rerender(<WithQueries><InsightsTab /></WithQueries>);
}
