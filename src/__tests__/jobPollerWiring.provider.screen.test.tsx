// WHIT-629 QA — the two users of the shared job poller keep today's behaviour:
//   - the rules job carries its dropped-connection count across a dismiss + reopen, and a fresh job
//     starts from zero again;
//   - the chat's overall time limit counts from BEFORE the start request, not from the first check.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useAppContext, APPLY_RULES_MAX_WRITES } from '../context';
import type { ApplyRulesJob, FilingTarget, FilingWhen } from '../context';
import { queryClient } from '../queryClient';
import type { ChatJob } from '../api';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
import { CHAT_ERROR_TEXT, CHAT_MAX_WAIT_MS, CHAT_POLL_DELAY_MS, ChatProvider, useChat } from '../chat/ChatContext';
const SWEEP: FilingTarget = { kind: 'sweep' };
const BIG_RUN: FilingWhen = { matched: APPLY_RULES_MAX_WRITES + 1 }; // over the cap → a background job
import type { ChatContextValue } from '../chat/ChatContext';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

const POLL = 2500; // APPLY_RULES_JOB_POLL_DELAY_MS

async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  }
}

beforeEach(async () => {
  queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; mockListeners.clear();
  await AsyncStorage.clear();
});
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('[A10] dropped connections before a dismiss still count after the sheet is reopened', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockRejectedValue(new Error('offline'));

  const r = renderHook(() => useAppContext(), { wrapper }).result;
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick(3); // 3 of the 5 allowed drops
  expect(r.current.applyRulesJob?.status).toBe('running');

  await act(async () => { r.current.setSheet(null); });
  await tick(4); // dismissed → no polling
  expect(mockApi.getApplyRulesJob).toHaveBeenCalledTimes(3);

  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await tick(2); // 2 more drops → 5 in a row → gives up
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

it('[A11] a new job after a network give-up starts its dropped-connection count from zero', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockRejectedValue(new Error('offline'));

  const r = renderHook(() => useAppContext(), { wrapper }).result;
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick(5);
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });

  await act(async () => { await r.current.retryApplyRulesJob(); });
  await tick(4); // 4 drops on the new job → still running
  expect(r.current.applyRulesJob?.status).toBe('running');
  await tick(1);
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

it('[A12] a dismiss after a good check carries zero drops, not a stale count', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(job({ matched: 10, attempted: 1 })) // resets the count
    .mockRejectedValue(new Error('offline'));

  const r = renderHook(() => useAppContext(), { wrapper }).result;
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick(4);
  await act(async () => { r.current.setSheet(null); });
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await tick(4); // 4 fresh drops → still under 5
  expect(r.current.applyRulesJob?.status).toBe('running');
  await tick(1);
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

let chat: ChatContextValue;
function Probe() {
  chat = useChat();
  return null;
}

it('[A13] the chat time limit counts from before the start request, not from the first check', async () => {
  let resolveStart: (value: ChatJob) => void = () => {};
  mockApi.startAiChat.mockImplementation(() => new Promise<ChatJob>((resolve) => { resolveStart = resolve; }));
  mockApi.getAiChatJob.mockResolvedValue({ jobId: 'c1', status: 'running' });

  render(<ChatProvider><Probe /></ChatProvider>);
  await act(async () => { await Promise.resolve(); });
  act(() => chat.send('how much on coffee?'));

  // The start request itself eats almost the whole budget.
  await act(async () => { jest.advanceTimersByTime(CHAT_MAX_WAIT_MS - CHAT_POLL_DELAY_MS / 2); });
  await act(async () => { resolveStart({ jobId: 'c1', status: 'running' }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(CHAT_POLL_DELAY_MS); });

  expect(mockApi.getAiChatJob).not.toHaveBeenCalled();
  expect(chat.inFlight).toBe(false);
  expect(chat.messages[chat.messages.length - 1]).toMatchObject({ role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT });
});
