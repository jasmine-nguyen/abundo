// Card 609 — "Ask a follow-up →" on the Insights AI card: shown only once there is advice, and it
// opens the chat seeded with the card's summary (the chat provider focuses the keyboard for a seed).
// WHIT-687 — the card's goal inputs come from the real screen data code over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { styleOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
import { resetAi, setAi } from './support/insightsScreen';
const mockOpenChat = jest.fn();
jest.mock('../chat/ChatContext', () => ({ useChat: () => ({ openChat: mockOpenChat }) }));

import { AiCoachCard } from '../components/AiCoachCard';

installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetAi();
  mockOpenChat.mockClear();
});

it('opens the chat seeded with the summary', async () => {
  setAi({ insights: { summary: 'You are pacing well this cycle.', suggestions: ['Trim coffee'], generated_at: '2026-09-20T00:00:00Z', cycle_start: '2026-09-01', cached: false } });
  await renderWithQueries(<AiCoachCard />);
  expect(styleOf(screen.getByTestId('ai-ask-follow-up')).minHeight).toBe(44); // ABU-63: a full-size tap target
  fireEvent.press(screen.getByText('Ask a follow-up →'));
  expect(mockOpenChat).toHaveBeenCalledWith({ seed: 'You are pacing well this cycle.' });
});
