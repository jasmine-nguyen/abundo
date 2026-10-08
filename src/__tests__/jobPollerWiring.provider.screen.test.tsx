// WHIT-629 QA — the two users of the shared job poller keep today's behaviour:
//   - the rules job carries its dropped-connection count across a dismiss + reopen, and a fresh job
//     starts from zero again;
//   - the chat's overall time limit counts from BEFORE the start request, not from the first check.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppContext, APPLY_RULES_MAX_WRITES } from '../context';
import type { ApplyRulesJob, FilingTarget, FilingWhen } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { CHAT_ERROR_TEXT, CHAT_MAX_WAIT_MS, CHAT_POLL_DELAY_MS, ChatProvider, useChat } from '../chat/ChatContext';
const SWEEP: FilingTarget = { kind: 'sweep' };
const BIG_RUN: FilingWhen = { matched: APPLY_RULES_MAX_WRITES + 1 }; // over the cap → a background job
import type { ChatContextValue } from '../chat/ChatContext';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const jobPath = (jobId: string) => `/transactions/uncategorized/apply-rules/jobs/${jobId}`;
const gets = (prefix: string) => server.sentUnder('GET', prefix).length;
const drop = (path: string, times: number) => {
  for (let i = 0; i < times; i++) server.once('GET', path, 'dropped');
};

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'job-1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
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
  queryClient.clear(); jest.useFakeTimers(); resetAuth();
  await AsyncStorage.clear();
});
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('[A10] dropped connections before a dismiss still count after the sheet is reopened', async () => {
  drop(jobPath('job-1'), 5);

  const r = renderHook(() => useAppContext(), { wrapper }).result;
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick(3); // 3 of the 5 allowed drops
  expect(r.current.applyRulesJob?.status).toBe('running');

  await act(async () => { r.current.setSheet(null); });
  await tick(4); // dismissed → no polling
  expect(gets(jobPath('job-1'))).toBe(3);

  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await tick(2); // 2 more drops → 5 in a row → gives up
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

it('[A11] a new job after a network give-up starts its dropped-connection count from zero', async () => {
  drop(jobPath('job-1'), 5);
  drop(jobPath('job-2'), 5); // the retry's fresh job

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
  drop(jobPath('job-1'), 3);
  server.once('GET', jobPath('job-1'), { body: job({ matched: 10, attempted: 1 }) }); // resets the count
  drop(jobPath('job-1'), 5);

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
  const start = server.hold('/ai/chat');

  render(<ChatProvider><Probe /></ChatProvider>);
  await act(async () => { await Promise.resolve(); });
  act(() => chat.send('how much on coffee?'));

  // The start request itself eats almost the whole budget. The clock jumps rather than the timers
  // running, so the start request's own 15s cancel timer doesn't end it first.
  await act(async () => { jest.setSystemTime(Date.now() + CHAT_MAX_WAIT_MS - CHAT_POLL_DELAY_MS / 2); });
  await act(async () => { start.release(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(CHAT_POLL_DELAY_MS); });

  expect(gets('/ai/chat/jobs/')).toBe(0);
  expect(chat.inFlight).toBe(false);
  expect(chat.messages[chat.messages.length - 1]).toMatchObject({ role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT });
});
