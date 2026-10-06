// Card 610 — Ask Abundo: a light haptic buzz when the composer's Send button sends a message.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { installFakeServer } from './support/fakeServer';
import { resetAuth } from './support/authMock';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { flush } from './support/queryClient';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { ChatProvider, CHAT_CONSENT_KEY, useChat } from '../chat/ChatContext';
import type { ChatContextValue } from '../chat/ChatContext';
import { ChatSheet } from '../chat/ChatSheet';

const server = installFakeServer();
useTestQueryClient();

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

beforeEach(async () => {
  jest.clearAllMocks();
  resetAuth();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(CHAT_CONSENT_KEY, '2026-09-01T00:00:00.000Z');
});

describe('Ask Abundo send haptic', () => {
  it('pressing Send with a typed message gives one light buzz', async () => {
    await mountOpen();
    fireEvent.changeText(screen.getByTestId('chat-input'), 'How much on coffee?');
    fireEvent.press(screen.getByTestId('chat-send'));
    await flush();

    expect(server.sent('POST', '/ai/chat')).toHaveLength(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('pressing the disabled Send button on an empty box gives no buzz', async () => {
    await mountOpen();
    expect(screen.getByTestId('chat-send').props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('chat-send'));
    await flush();

    expect(server.sent('POST', '/ai/chat')).toHaveLength(0);
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });
});
