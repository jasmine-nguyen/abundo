// Card 609 — the Ask Abundo chat provider: send → background job → checked every second → answer.
// The real API runs against the fake server, auth is mocked; fake timers drive the checking loop.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatJob } from '../api';
import { installFakeServer } from './support/fakeServer';
import { flush } from './support/queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';

import {
  CHAT_CONSENT_KEY, CHAT_ERROR_TEXT, CHAT_MAX_NET_ERRORS, CHAT_MAX_WAIT_MS, CHAT_MESSAGE_MAX_LEN, CHAT_POLL_DELAY_MS,
  ChatProvider, chatHistory, useChat,
} from '../chat/ChatContext';
import type { ChatContextValue, ChatMessage } from '../chat/ChatContext';

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
  resetAuth();
  await AsyncStorage.clear();
});

afterEach(() => { jest.useRealTimers(); });

describe('sending a question', () => {
  it('shows the typing state and status line, then the answer', async () => {
    nextCheck({ status: 'running', toolStatus: 'Looking at Eating Out, last 3 cycles…' });
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();

    act(() => chat.send('  Average eating out?  '));
    await flush();
    expect(chatPosts().map((request) => request.body)).toEqual([{ messages: [{ role: 'user', text: 'Average eating out?' }] }]);
    expect(chat.inFlight).toBe(true);

    await tick();
    expect(chat.toolStatus).toBe('Looking at Eating Out, last 3 cycles…');

    await tick();
    expect(chat.inFlight).toBe(false);
    expect(chat.toolStatus).toBeNull();
    const last = chat.messages[chat.messages.length - 1];
    expect(last).toMatchObject({ role: 'assistant', status: 'done', text: REPLY.text, reply: REPLY });
  });

  it('ignores a blank message and a second send while one is in flight', async () => {
    await mount();
    act(() => chat.send('   '));
    expect(chatPosts()).toHaveLength(0);

    act(() => chat.send('first'));
    await flush();
    act(() => chat.send('second'));
    await flush();
    expect(chatPosts()).toHaveLength(1);
  });
});

describe('stop', () => {
  it('stops checking and throws the answer away', async () => {
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Average eating out?'));
    await flush();

    act(() => chat.stop());
    await tick();
    await tick();

    expect(jobChecks()).toHaveLength(0);
    expect(chat.inFlight).toBe(false);
    expect(chat.messages.map((message) => message.role)).toEqual(['user']);
  });
});

describe('errors and retry', () => {
  it('a failed start shows the error bubble; Retry resends without duplicating the question', async () => {
    server.once('POST', '/ai/chat', 'dropped');
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();

    act(() => chat.send('Average eating out?'));
    await flush();
    expect(chat.messages[1]).toMatchObject({ role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT });

    act(() => chat.retry());
    await flush();
    expect(chatPosts().map((request) => request.body)).toEqual([
      { messages: [{ role: 'user', text: 'Average eating out?' }] },
      { messages: [{ role: 'user', text: 'Average eating out?' }] },
    ]);
    await tick();
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(chat.messages[1]).toMatchObject({ status: 'done', text: REPLY.text });
  });

  it('a job the server marks failed shows the error bubble', async () => {
    nextCheck({ status: 'failed', error: 'assistant unavailable' });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'error' });
    expect(chat.inFlight).toBe(false);
  });

  it('a gone job (404) fails straight away', async () => {
    server.fail(JOB, 404);
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'error' });
  });

  it('tolerates a few dropped network calls, then answers', async () => {
    for (let i = 0; i < CHAT_MAX_NET_ERRORS - 1; i += 1) server.once('GET', JOB, 'dropped');
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    for (let i = 0; i < CHAT_MAX_NET_ERRORS; i += 1) await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'done' });
  });

  it('gives up after too many dropped calls in a row', async () => {
    for (let i = 0; i < CHAT_MAX_NET_ERRORS; i += 1) server.once('GET', JOB, 'dropped');
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    for (let i = 0; i < CHAT_MAX_NET_ERRORS; i += 1) await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'error' });
    expect(chat.inFlight).toBe(false);
  });

  it('gives up when the answer takes too long overall', async () => {
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    const checks = Math.ceil(CHAT_MAX_WAIT_MS / CHAT_POLL_DELAY_MS) + 2;
    for (let i = 0; i < checks; i += 1) await tick();
    expect(chat.messages[1]).toMatchObject({ status: 'error' });
  });
});

describe('opening, new chat and sign-out', () => {
  it('a follow-up opens a fresh thread seeded with the summary and focuses the keyboard', async () => {
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('old question'));
    await flush();
    await tick();

    act(() => chat.openChat({ seed: 'You are on track this cycle.' }));
    expect(chat.open).toBe(true);
    expect(chat.autoFocus).toBe(true);
    expect(chat.messages).toEqual([expect.objectContaining({ role: 'assistant', status: 'done', text: 'You are on track this cycle.' })]);

    act(() => chat.closeChat());
    act(() => chat.openChat());
    expect(chat.autoFocus).toBe(false);
    expect(chat.messages).toHaveLength(1); // the thread survives closing
  });

  it('a follow-up summary longer than the server allows is cut to fit', async () => {
    // The server rejects any message over CHAT_MESSAGE_MAX_LEN, so an uncut seed would make every
    // question in the thread fail — and Retry with it.
    await mount();
    act(() => chat.openChat({ seed: 'x'.repeat(CHAT_MESSAGE_MAX_LEN + 500) }));
    expect(chat.messages[0].text).toHaveLength(CHAT_MESSAGE_MAX_LEN);
  });

  it('New chat clears the thread', async () => {
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    act(() => chat.newChat());
    expect(chat.messages).toEqual([]);
    expect(chat.inFlight).toBe(false);
  });

  it('signing out clears the conversation and closes the sheet', async () => {
    await mount();
    act(() => chat.openChat());
    act(() => chat.send('Hi'));
    await flush();

    act(() => setAuthStatus('anon'));
    expect(chat.messages).toEqual([]);
    expect(chat.open).toBe(false);
    expect(chat.inFlight).toBe(false);
  });
});

describe('consent', () => {
  it('is saved with a timestamp and read back on the next launch', async () => {
    const first = await mount();
    expect(chat.consentLoaded).toBe(true);
    expect(chat.consentedAt).toBeNull();

    act(() => chat.acceptConsent());
    await flush();
    expect(chat.consentedAt).not.toBeNull();
    expect(await AsyncStorage.getItem(CHAT_CONSENT_KEY)).toBe(chat.consentedAt);

    first.unmount();
    await mount();
    expect(chat.consentedAt).toBe(await AsyncStorage.getItem(CHAT_CONSENT_KEY));
  });
});

describe('chatHistory', () => {
  it('keeps questions and finished answers (with their source), drops errors, keeps the last 20', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'q1' },
      { id: '2', role: 'assistant', status: 'done', text: 'a1', reply: { text: 'a1', source: 'last 3 cycles' } },
      { id: '3', role: 'user', text: 'q2' },
      { id: '4', role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT },
      { id: '5', role: 'user', text: 'q3' },
    ];
    expect(chatHistory(messages)).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1 (Source: last 3 cycles)' },
      { role: 'user', text: 'q2' },
      { role: 'user', text: 'q3' },
    ]);

    const long: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, role: 'user' as const, text: `q${i}` }));
    const trimmed = chatHistory(long);
    expect(trimmed).toHaveLength(20);
    expect(trimmed[19]).toEqual({ role: 'user', text: 'q24' });
  });

  it('a trimmed history starts on a question, never an old answer', () => {
    // 11 questions + 10 answers: the last 20 would start with answer a0, which the server reads
    // as the insights summary seed. The trim drops it so the history starts on q1.
    const turns: ChatMessage[] = [];
    for (let i = 0; i < 11; i++) {
      turns.push({ id: `q${i}`, role: 'user', text: `q${i}` });
      if (i < 10) turns.push({ id: `a${i}`, role: 'assistant', status: 'done', text: `a${i}` });
    }
    const trimmed = chatHistory(turns);
    expect(trimmed).toHaveLength(19);
    expect(trimmed[0]).toEqual({ role: 'user', text: 'q1' });
    expect(trimmed[18]).toEqual({ role: 'user', text: 'q10' });
  });

  it('a short seeded history keeps the seed first', () => {
    const seeded: ChatMessage[] = [
      { id: 's', role: 'assistant', status: 'done', text: 'summary' },
      { id: 'q', role: 'user', text: 'why?' },
    ];
    expect(chatHistory(seeded)[0]).toEqual({ role: 'assistant', text: 'summary' });
  });
});

// ===== QA (card 609) — races and odd server states the happy path doesn't reach =====

describe('QA edges', () => {
  // [A15] New chat while the POST is still in the air: when it lands, the old job must not start
  // polling or drop its answer into the fresh thread.
  it('a start that resolves after New chat never polls or answers', async () => {
    const start = server.hold('/ai/chat');
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Average eating out?'));
    await flush();

    act(() => chat.newChat());
    await act(async () => { start.release(); });
    await tick();
    await tick();

    expect(jobChecks()).toHaveLength(0);
    expect(chat.messages).toEqual([]);
    expect(chat.inFlight).toBe(false);
  });

  // [A16] A "succeeded" job with no reply is a broken answer, not a blank bubble — and the loop
  // stops instead of polling on.
  it('a succeeded job with no reply shows the error bubble straight away and stops checking', async () => {
    nextCheck({ status: 'succeeded', reply: null });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();

    expect(chat.messages[1]).toMatchObject({ role: 'assistant', status: 'error', text: CHAT_ERROR_TEXT });
    expect(chat.inFlight).toBe(false);
    await tick();
    expect(jobChecks()).toHaveLength(1);
  });

  // [A17] Retry only replaces an error bubble. After a good answer it must do nothing — otherwise
  // it would chop off the answer and resend (a second paid run).
  it('Retry after a good answer does nothing', async () => {
    nextCheck({ status: 'succeeded', reply: REPLY });
    await mount();
    act(() => chat.send('Hi'));
    await flush();
    await tick();
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    act(() => chat.retry());
    await flush();
    expect(chatPosts()).toHaveLength(1);
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
