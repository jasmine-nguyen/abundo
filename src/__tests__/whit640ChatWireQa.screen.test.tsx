// WHIT-640 QA — the Ask Abundo provider on the real api.ts: which HTTP failures on the start and
// on a check end the answer, and how many requests each one costs. The old suites faked
// startAiChat/getAiChatJob, so the ApiError status wiring (api.ts "statusOnly") never ran.
// Same harness as chatContext.provider.screen.test.tsx (fake server, auth mocked, fake timers).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { flush } from './support/queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { CHAT_ERROR_TEXT, CHAT_POLL_DELAY_MS, ChatProvider, useChat } from '../chat/ChatContext';
import type { ChatContextValue } from '../chat/ChatContext';

const server = installFakeServer();
const JOB = '/ai/chat/jobs/chat-1';
const chatPosts = () => server.sent('POST', '/ai/chat');
const jobChecks = () => server.sent('GET', JOB);

let chat: ChatContextValue;
function Probe() {
  chat = useChat();
  return null;
}

async function tick(ms = CHAT_POLL_DELAY_MS) {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await flush();
}

async function mount() {
  render(<ChatProvider><Probe /></ChatProvider>);
  await flush();
}

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
});

afterEach(() => { jest.useRealTimers(); });

describe('a failed start', () => {
  // [A11]
  it.each([400, 429, 500])('[A11] a %i on POST /ai/chat shows the error bubble and never checks a job', async (status) => {
    server.once('POST', '/ai/chat', { status });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    await tick();

    expect(chatPosts()).toHaveLength(1);
    expect(jobChecks()).toHaveLength(0);
    expect(chat.messages[1]).toMatchObject({ role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT });
    expect(chat.inFlight).toBe(false);
  });
});

describe('a gone job', () => {
  // [A12] A 404 must reach the poller as ApiError(404) and end it after ONE check. If the status
  // were lost (a plain Error), it would count as a dropped call and keep checking.
  it('[A12] a 404 on the first check stops after exactly one check', async () => {
    server.fail(JOB, 404);
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    await tick();
    await tick();

    expect(jobChecks()).toHaveLength(1);
    expect(chat.messages[1]).toMatchObject({ status: 'error', text: CHAT_ERROR_TEXT });
    expect(chat.inFlight).toBe(false);
  });
});
