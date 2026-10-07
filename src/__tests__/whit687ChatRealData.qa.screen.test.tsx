// WHIT-687 QA — slice 1 edges the moved chat suites don't reach: the advice card's goal note and
// re-analyse goal come from the real loan reads, and the chat answer's colour follows the real
// category read when it lands late, fails, or carries slot 0.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ChatReply } from '../api';
import { chartCategoryColor } from '../chartColors';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

let mockAi: { summary: string; suggestions: string[]; generated_at: string } | null = null;
const mockGenerate = jest.fn();
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({
  aiInsights: mockAi, aiInsightsLoading: false, aiInsightsError: false, generateAiInsights: mockGenerate,
})));
jest.mock('../chat/ChatContext', () => ({ useChat: () => ({ openChat: jest.fn() }) }));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { AiCoachCard } from '../components/AiCoachCard';
import { ChatAnswer } from '../chat/ChatAnswer';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  mockAi = null;
});

const READY_LOAN_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

describe('the advice card goal comes from the real loan reads', () => {
  // [A1]
  it('names home-loan figures and sends the goal once the server has loan facts and a balance', async () => {
    server.seed('/loanfacts', READY_LOAN_FACTS);
    server.seed('/homeloan', { balance: 528000, as_of: null, currency: 'AUD' });
    await renderWithQueries(<AiCoachCard />);

    expect(screen.getByText(/home-loan figures \(balance, rate, repayments\)/)).toBeTruthy();
    fireEvent.press(screen.getByText('Analyse my spending'));
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead' }));
  });

  // [A2]
  it('stays spend-only and sends no goal when the loan facts read fails', async () => {
    server.fail('/loanfacts', 500);
    server.seed('/homeloan', { balance: 528000, as_of: null, currency: 'AUD' });
    await renderWithQueries(<AiCoachCard />);

    expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
    expect(screen.queryByText(/home-loan figures/)).toBeNull();
    fireEvent.press(screen.getByText('Analyse my spending'));
    expect(mockGenerate).toHaveBeenCalledWith(null);
  });

  // [A3]
  it('the compact re-analyse forwards the real goal once advice exists', async () => {
    mockAi = { summary: 'ok', suggestions: ['a'], generated_at: '2026-09-20T00:00:00Z' };
    server.seed('/loanfacts', READY_LOAN_FACTS);
    server.seed('/homeloan', { balance: 528000, as_of: null, currency: 'AUD' });
    await renderWithQueries(<AiCoachCard />);

    expect(screen.getByText(/Re-analysing sends your category spend totals and home-loan figures/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead' }));
  });
});

const REPLY: ChatReply = {
  text: 'ok',
  source: '3 completed pay cycles',
  card: {
    type: 'metric_bars', label: 'Eating Out', value: 31.11, categoryId: 'eatingout',
    budgetLine: 60, delta: { amount: -28.89, vs: 'budget' },
    series: [{ label: '30 Jul', value: 60 }, { label: '13 Aug', value: 0 }],
  },
  actions: [],
};

function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return (style as Record<string, unknown>) ?? {};
}
const dotColor = () => flat(screen.getByTestId('chat-card-dot').props.style).backgroundColor;

describe('the chat answer colour follows the real category read', () => {
  // [A4]
  it('redraws in the slot colour when the category read lands after the answer', async () => {
    server.seed('/categories', [{ id: 'eatingout', name: 'Eating Out', parent: null, colorSlot: 5 }]);
    const held = server.hold('/categories');
    render(<WithQueries><ChatAnswer text="ok" reply={REPLY} onAction={() => {}} /></WithQueries>);

    expect(dotColor()).toBe(chartCategoryColor('eatingout'));
    await refreshInAct(() => held.release());
    await waitFor(() => expect(dotColor()).toBe(chartCategoryColor('eatingout', { slot: 5 })));
    expect(chartCategoryColor('eatingout', { slot: 5 })).not.toBe(chartCategoryColor('eatingout'));
  });

  // [A5]
  it('keeps slot 0 — a real slot — instead of falling back to the id colour', async () => {
    server.seed('/categories', [{ id: 'dogwalks', name: 'Dog walks', parent: null, colorSlot: 0 }]);
    const card = { ...REPLY.card!, categoryId: 'dogwalks' };
    await renderWithQueries(<ChatAnswer text="ok" reply={{ ...REPLY, card }} onAction={() => {}} />);

    const slotZero = chartCategoryColor('dogwalks', { slot: 0 });
    expect(slotZero).not.toBe(chartCategoryColor('dogwalks'));
    expect(dotColor()).toBe(slotZero);
  });

  // [A6]
  it('still draws the answer, in the id colour, when the category read fails', async () => {
    server.fail('/categories', 500);
    await renderWithQueries(<ChatAnswer text="ok" reply={REPLY} onAction={() => {}} />);

    expect(screen.getAllByTestId('chat-card-bar')).toHaveLength(2);
    expect(dotColor()).toBe(chartCategoryColor('eatingout'));
  });
});
