// WHIT-138 (client seam guard) — a 502 "insights unavailable" from the paid
// generateAiInsights call must flip the AppProvider into its retry state:
// aiInsightsError = true and aiInsightsLoading cleared, so the Insights screen
// renders "Couldn't generate insights. Please try again." + a working "Try again".
// The api-level 502 throw is already covered by api.logic.test.ts
// ("generateAiInsights throws on a 502"); the rendered retry UI given
// aiInsightsError=true by InsightsScreen.screen.test.tsx. This closes the one
// untested link between them: the context callback's catch -> setAiInsightsError.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('a 502 from generateAiInsights sets aiInsightsError and clears loading', async () => {
  // The real api call rejects exactly as it does on a server 502 (see api.ts:561).
  mockApi.generateAiInsights.mockRejectedValue(new Error('API error: 502'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  expect(result.current.aiInsightsError).toBe(false);

  await act(async () => { await result.current.generateAiInsights(null); });

  expect(mockApi.generateAiInsights).toHaveBeenCalledTimes(1);
  expect(result.current.aiInsightsError).toBe(true);   // retry state is armed
  expect(result.current.aiInsightsLoading).toBe(false); // spinner is cleared
  expect(result.current.aiInsights).toBeNull();         // no stale success shown
});

it('a later successful re-tap clears the error state', async () => {
  // Re-tapping "Try again" after an empty/502 must recover: WHIT-138 makes the
  // server regenerate, and the client must drop aiInsightsError on success.
  mockApi.generateAiInsights
    .mockRejectedValueOnce(new Error('API error: 502'))
    .mockResolvedValueOnce({ summary: 'Solid cycle.', suggestions: ['Cut coffee'], generated_at: 't', cycle_start: '2026-06-25', cached: false } as any);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.generateAiInsights(null); });
  expect(result.current.aiInsightsError).toBe(true);

  await act(async () => { await result.current.generateAiInsights(null); });
  await waitFor(() => expect(result.current.aiInsightsError).toBe(false));
  expect(result.current.aiInsights?.summary).toBe('Solid cycle.');
});
