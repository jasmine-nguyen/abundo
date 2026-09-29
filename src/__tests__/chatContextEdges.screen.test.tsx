// Card 609 QA — Ask Abundo provider edge cases: late answers after a thread is replaced, sign-out
// mid-start, which failures are retried, and what the seeded follow-up thread sends. Same harness
// as chatContext.provider.screen.test.tsx (real API on the fake server, auth mocked, fake timers).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatJob } from '../api';
import { installFakeServer } from './support/fakeServer';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (listener: () => void) => { mockAuthListeners.add(listener); return () => mockAuthListeners.delete(listener); },
  getAuthToken: async () => 'test-id-token',
}));

import { CHAT_ERROR_TEXT, CHAT_MAX_NET_ERRORS, CHAT_POLL_DELAY_MS, ChatProvider, useChat } from '../chat/ChatContext';
import type { ChatContextValue } from '../chat/ChatContext';

const server = installFakeServer();

// The first POST /ai/chat of each test starts job chat-1; the server then answers its checks
// "running" until told otherwise.
const JOB = '/ai/chat/jobs/chat-1';
const chatPosts = () => server.sent('POST', '/ai/chat');
const jobChecks = () => server.sent('GET', JOB);
const nextCheck = (job: Omit<ChatJob, 'jobId'>) => server.once('GET', JOB, { body: { jobId: 'chat-1', ...job } });

const REPLY = { text: 'You spent **$31.11** per cycle.', source: '3 completed pay cycles · 30 Jul – 9 Sep' };

let chat: ChatContextValue;
function Probe() {
  chat = useChat();
  return null;
}

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

async function tick(ms = CHAT_POLL_DELAY_MS) {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await flush();
}

async function mount() {
  const view = render(<ChatProvider><Probe /></ChatProvider>);
  await flush();
  return view;
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  await AsyncStorage.clear();
});

afterEach(() => { jest.useRealTimers(); });


describe('late answers never land in the wrong thread', () => {
  it('[A22a] a follow-up opened mid-answer drops the old job\'s late reply', async () => {
    const poll = server.hold(JOB);
    await mount();
    act(() => chat.send('old question'));
    await flush();
    await tick(); // the poll is now in flight

    act(() => chat.openChat({ seed: 'You are on track this cycle.' }));
    nextCheck({ status: 'succeeded', reply: REPLY });
    await act(async () => { poll.release(); });
    await flush();

    expect(jobChecks()).toHaveLength(1);
    expect(chat.messages).toEqual([expect.objectContaining({ text: 'You are on track this cycle.' })]);
    expect(chat.inFlight).toBe(false);
  });

  it('[A22f] signing out while the start request is pending never starts checking', async () => {
    const start = server.hold('/ai/chat');
    await mount();
    act(() => chat.send('Hi'));
    await flush();

    mockAuthStatus = 'anon';
    act(() => mockAuthListeners.forEach((listener) => listener()));
    await act(async () => { start.release(); });
    await tick();
    await tick();

    expect(jobChecks()).toHaveLength(0);
    expect(chat.messages).toEqual([]);
  });
});

describe('which failures are retried', () => {
  it('[A22b] a server error (5xx) on a check is retried like a dropped call, not a hard fail', async () => {
    server.once('GET', JOB, { status: 503 });
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    expect(chat.messages).toHaveLength(1);
    expect(chat.inFlight).toBe(true);
    await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'done', text: REPLY.text });
  });

  it('[A22c] a good check resets the dropped-call count', async () => {
    const drops = CHAT_MAX_NET_ERRORS - 1;
    for (let i = 0; i < drops; i += 1) server.once('GET', JOB, 'dropped');
    nextCheck({ status: 'running' });
    for (let i = 0; i < drops; i += 1) server.once('GET', JOB, 'dropped');
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    for (let i = 0; i < drops * 2 + 2; i += 1) await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'done' });
  });

  it('[A22d] a succeeded job with no reply is an error, not a blank answer', async () => {
    nextCheck({ status: 'succeeded', reply: null });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'error', text: CHAT_ERROR_TEXT });
  });
});

describe('the follow-up thread', () => {
  it('[A22h] the first question after a seed sends the summary as the opening answer', async () => {
    await mount();
    act(() => chat.openChat({ seed: 'You are on track this cycle.' }));
    act(() => chat.send('Why?'));
    await flush();
    expect(chatPosts().map((request) => request.body)).toEqual([{ messages: [
      { role: 'assistant', text: 'You are on track this cycle.' },
      { role: 'user', text: 'Why?' },
    ] }]);
  });

  it('[A22e] Retry after a failed follow-up resends the seed and the question once each', async () => {
    server.once('POST', '/ai/chat', 'dropped');
    await mount();
    act(() => chat.openChat({ seed: 'Summary.' }));
    act(() => chat.send('Why?'));
    await flush();
    expect(chat.messages[2]).toMatchObject({ status: 'error' });

    act(() => chat.retry());
    await flush();
    const resent = { messages: [
      { role: 'assistant', text: 'Summary.' },
      { role: 'user', text: 'Why?' },
    ] };
    expect(chatPosts().map((request) => request.body)).toEqual([resent, resent]);
    expect(chat.messages.map((message) => message.role)).toEqual(['assistant', 'user']);
  });
});
