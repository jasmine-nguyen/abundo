// Card 609 — "Ask a follow-up →" on the Insights AI card: shown only once there is advice, and it
// opens the chat seeded with the card's summary (the chat provider focuses the keyboard for a seed).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

let mockAi: { summary: string; suggestions: string[]; generated_at: string } | null = null;
jest.mock('../context', () => ({
  useAppContext: () => ({
    aiInsights: mockAi, aiInsightsLoading: false, aiInsightsError: false, generateAiInsights: jest.fn(),
  }),
  aiGoalSignal: () => null,
}));
jest.mock('../queries', () => ({ useGoalScreenData: () => ({ loanFacts: {}, homeLoan: {} }) }));
const mockOpenChat = jest.fn();
jest.mock('../chat/ChatContext', () => ({ useChat: () => ({ openChat: mockOpenChat }) }));

import { AiCoachCard } from '../components/AiCoachCard';

beforeEach(() => { mockOpenChat.mockClear(); });

it('is hidden before there is any advice', () => {
  mockAi = null;
  render(<AiCoachCard />);
  expect(screen.queryByTestId('ai-ask-follow-up')).toBeNull();
});

it('opens the chat seeded with the summary', () => {
  mockAi = { summary: 'You are pacing well this cycle.', suggestions: ['Trim coffee'], generated_at: '2026-09-20T00:00:00Z' };
  render(<AiCoachCard />);
  fireEvent.press(screen.getByText('Ask a follow-up →'));
  expect(mockOpenChat).toHaveBeenCalledWith({ seed: 'You are pacing well this cycle.' });
});
