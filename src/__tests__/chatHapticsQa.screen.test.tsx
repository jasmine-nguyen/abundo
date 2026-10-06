// Card 610 QA — the send buzz fires only for the composer's Send button (sign-off Q1), once per
// real send, and a failing haptic never stops the message going out.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import type { ChatReply } from '../api';
import { installFakeServer } from './support/fakeServer';
import { resetAuth } from './support/authMock';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { flush } from './support/queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { ChatProvider, CHAT_CONSENT_KEY, useChat } from '../chat/ChatContext';
import type { ChatContextValue } from '../chat/ChatContext';
import { ChatSheet } from '../chat/ChatSheet';

const server = installFakeServer();
useTestQueryClient();
const chatPosts = () => server.sent('POST', '/ai/chat');
const impactAsync = jest.mocked(Haptics.impactAsync);

const REPLY: ChatReply = {
  text: 'You spent $31.11.',
  source: '3 completed pay cycles',
  actions: [{ kind: 'prompt', label: 'Compare to Groceries', text: 'Compare that to Groceries' }],
} as ChatReply;

let chat: ChatContextValue;
function Probe() {
  chat = useChat();
  return null;
}

async function mountOpen() {
  await renderWithQueries(<ChatProvider><Probe /><ChatSheet /></ChatProvider>);
  await flush();
  act(() => chat.openChat());
}

// Sends under fake timers so the poll for jobId can be stepped and answered with REPLY.
async function sendAndAnswer(doSend: () => void, jobId: string) {
  server.once('GET', `/ai/chat/jobs/${jobId}`, { body: { jobId, status: 'succeeded', reply: REPLY } });
  jest.useFakeTimers();
  doSend();
  await flush();
  await act(async () => { jest.advanceTimersByTime(1000); });
  await flush();
  jest.useRealTimers();
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetAuth();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(CHAT_CONSENT_KEY, '2026-09-01T00:00:00.000Z');
});

describe('Ask Abundo send haptic (QA)', () => {
  // [A1]
  it('a suggested prompt sends without a buzz', async () => {
    await mountOpen();
    fireEvent.press(screen.getByTestId('chat-prompt-0'));
    await flush();
    expect(chatPosts()).toHaveLength(1);
    expect(impactAsync).not.toHaveBeenCalled();
  });

  // [A2]
  it("an answer's follow-up chip sends without a buzz", async () => {
    await mountOpen();
    await sendAndAnswer(() => act(() => chat.send('Average eating out?')), 'chat-1');
    fireEvent.press(screen.getByTestId('chat-action-0'));
    await flush();
    expect(chatPosts()).toHaveLength(2);
    expect(impactAsync).not.toHaveBeenCalled();
  });

  // [A3]
  it('a rejected haptic still sends the message and clears the box', async () => {
    impactAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptic engine')));
    await mountOpen();
    fireEvent.changeText(screen.getByTestId('chat-input'), 'How much on coffee?');
    fireEvent.press(screen.getByTestId('chat-send'));
    await flush();
    expect(impactAsync).toHaveBeenCalledTimes(1);
    expect(chatPosts().map((request) => request.body)).toEqual([{ messages: [{ role: 'user', text: 'How much on coffee?' }] }]);
    expect(screen.getByTestId('chat-input').props.value).toBe('');
  });

  // [A4]
  it('buzzes once per Send across a follow-up; whitespace-only text cannot buzz', async () => {
    await mountOpen();
    fireEvent.changeText(screen.getByTestId('chat-input'), '   ');
    expect(screen.getByTestId('chat-send').props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('chat-input'), 'How much on coffee?');
    await sendAndAnswer(() => fireEvent.press(screen.getByTestId('chat-send')), 'chat-1');
    expect(screen.queryByTestId('chat-stop')).toBeNull();

    fireEvent.changeText(screen.getByTestId('chat-input'), 'And groceries?');
    fireEvent.press(screen.getByTestId('chat-send'));
    await flush();
    expect(chatPosts()).toHaveLength(2);
    expect(impactAsync).toHaveBeenCalledTimes(2);
    expect(impactAsync).toHaveBeenNthCalledWith(2, Haptics.ImpactFeedbackStyle.Light);
  });
});
