// Card 609 — the Ask Abundo sheet, rendered with the real chat provider: the one-time consent
// step, suggested prompts, the answer card's category colour, and the action chips.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatReply } from '../api';
import { chartCategoryColor } from '../chartColors';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// Eating Out carries a stored colour slot that differs from its built-in default, so a card that
// ignored the slot would draw a different colour. The real category reads load them off the server.
const EATING_OUT = { id: 'eatingout', name: 'Eating Out', parent: null, colorSlot: 5 };
const SALARY = { id: 'salary', name: 'Salary', parent: null, bucket: 'Income', colorSlot: 2 };

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { ChatProvider, CHAT_CONSENT_KEY, useChat } from '../chat/ChatContext';
import type { ChatContextValue } from '../chat/ChatContext';
import { ChatSheet } from '../chat/ChatSheet';
import { ChatAnswer } from '../chat/ChatAnswer';
import { C } from '../theme';

const server = installFakeServer();
useTestQueryClient();
const chatPosts = () => server.sent('POST', '/ai/chat');

const REPLY: ChatReply = {
  text: 'You spent **$31.11** per cycle on Eating Out.',
  source: '3 completed pay cycles · 30 Jul – 9 Sep',
  card: {
    type: 'metric_bars', label: 'Eating Out · 3-cycle average', value: 31.11, categoryId: 'eatingout',
    budgetLine: 60, delta: { amount: -28.89, vs: 'budget' },
    series: [{ label: '30 Jul', value: 60 }, { label: '13 Aug', value: 0 }, { label: '27 Aug', value: 33.34 }],
  },
  actions: [
    { kind: 'deeplink', label: 'See Eating Out transactions', categoryId: 'eatingout', dateFrom: '2026-07-30', dateTo: '2026-09-09' },
    { kind: 'prompt', label: 'Compare to Groceries', text: 'Compare that to Groceries' },
  ],
};

let chat: ChatContextValue;
function Probe() {
  chat = useChat();
  return null;
}

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

async function mountOpen() {
  const view = await renderWithQueries(<ChatProvider><Probe /><ChatSheet /></ChatProvider>);
  await flush();
  act(() => chat.openChat());
  return view;
}

// The first question starts job chat-1; its first check comes back with REPLY.
async function askAndAnswer() {
  server.once('GET', '/ai/chat/jobs/chat-1', { body: { jobId: 'chat-1', status: 'succeeded', reply: REPLY } });
  jest.useFakeTimers();
  act(() => chat.send('Average eating out?'));
  await flush();
  await act(async () => { jest.advanceTimersByTime(1000); });
  await flush();
  // The answer card is the first thing to read categories: let that read land and redraw the card
  // (the query library schedules its redraw on a timer).
  await act(async () => { jest.advanceTimersByTime(0); });
  await flush();
  jest.useRealTimers();
  await settle();
}

beforeEach(async () => {
  resetRouter();
  jest.clearAllMocks();
  resetAuth();
  server.seed('/categories', [EATING_OUT, SALARY]);
  await AsyncStorage.clear();
});

describe('consent', () => {
  it('shows once; after Continue it never shows again', async () => {
    const first = await mountOpen();
    expect(screen.getByTestId('chat-consent')).toBeTruthy();
    expect(screen.queryByTestId('chat-prompt-0')).toBeNull();

    fireEvent.press(screen.getByTestId('chat-consent-continue'));
    await flush();
    expect(screen.queryByTestId('chat-consent')).toBeNull();
    expect(screen.getByText('What do you want to know about your spending?')).toBeTruthy();

    first.unmount();
    await mountOpen();
    expect(screen.queryByTestId('chat-consent')).toBeNull();
  });

  it('Not now closes the sheet without saving consent', async () => {
    await mountOpen();
    fireEvent.press(screen.getByTestId('chat-consent-not-now'));
    expect(chat.open).toBe(false);
    expect(await AsyncStorage.getItem(CHAT_CONSENT_KEY)).toBeNull();
  });
});

describe('with consent given', () => {
  beforeEach(async () => { await AsyncStorage.setItem(CHAT_CONSENT_KEY, '2026-09-01T00:00:00.000Z'); });

  it('a suggested prompt is sent straight away', async () => {
    await mountOpen();
    fireEvent.press(screen.getByTestId('chat-prompt-1'));
    await flush();
    expect(chatPosts().map((request) => request.body)).toEqual([
      { messages: [{ role: 'user', text: 'Average Eating Out over the last 3 months' }] },
    ]);
    expect(screen.getByTestId('chat-typing')).toBeTruthy();
  });

  it('typing and sending uses the text box; the send button is off while it is empty', async () => {
    await mountOpen();
    expect(screen.getByTestId('chat-send').props.accessibilityState?.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId('chat-input'), 'How much on coffee?');
    fireEvent.press(screen.getByTestId('chat-send'));
    await flush();
    expect(chatPosts().map((request) => request.body)).toEqual([{ messages: [{ role: 'user', text: 'How much on coffee?' }] }]);
    expect(screen.getByTestId('chat-stop')).toBeTruthy();
  });

  it('draws the answer card bars in the category colour from its colour slot', async () => {
    await mountOpen();
    await askAndAnswer();

    const expected = chartCategoryColor('eatingout', { slot: 5 });
    expect(expected).not.toBe(chartCategoryColor('eatingout'));
    const bars = screen.getAllByTestId('chat-card-bar');
    expect(bars).toHaveLength(3);
    for (const bar of bars) expect(StyleFlat(bar.props.style).backgroundColor).toBe(expected);
    expect(StyleFlat(screen.getByTestId('chat-card-dot').props.style).backgroundColor).toBe(expected);
    expect(screen.getByText('3 completed pay cycles · 30 Jul – 9 Sep')).toBeTruthy();
    expect(screen.getByText('$60 budget')).toBeTruthy();
  });

  it('a deep link closes the sheet and opens the category over the exact dates', async () => {
    await mountOpen();
    await askAndAnswer();
    fireEvent.press(screen.getByTestId('chat-action-0'));
    expect(chat.open).toBe(false);
    expect(routerSpies.push).toHaveBeenCalledWith('/category/eatingout?from=2026-07-30&to=2026-09-09');
  });

  it('a prompt chip sends its question', async () => {
    await mountOpen();
    await askAndAnswer();
    fireEvent.press(screen.getByTestId('chat-action-1'));
    await flush();
    const posts = chatPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual({ messages: expect.arrayContaining([
      { role: 'user', text: 'Compare that to Groceries' },
    ]) });
  });

  it('shows New chat only once a conversation exists', async () => {
    await mountOpen();
    expect(screen.queryByTestId('chat-new')).toBeNull();
    await askAndAnswer();
    fireEvent.press(screen.getByTestId('chat-new'));
    expect(chat.messages).toEqual([]);
    expect(screen.queryByTestId('chat-new')).toBeNull();
  });

  it('an error shows the message with a Retry chip', async () => {
    server.once('POST', '/ai/chat', 'dropped');
    await mountOpen();
    fireEvent.press(screen.getByTestId('chat-prompt-0'));
    await flush();
    expect(screen.getByText("Couldn't reach the assistant. Try again.")).toBeTruthy();
    fireEvent.press(screen.getByTestId('chat-retry'));
    await flush();
    expect(chatPosts()).toHaveLength(2);
  });
});

// RN style props may be arrays; flatten for the colour assertions.
function StyleFlat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(StyleFlat));
  return (style as Record<string, unknown>) ?? {};
}

describe('the answer card difference colour', () => {
  const deltaColor = async (categoryId: string, amount: number) => {
    const card = { ...REPLY.card!, categoryId, delta: { amount, vs: 'budget' as const } };
    await renderWithQueries(<ChatAnswer text="ok" reply={{ ...REPLY, card }} onAction={() => {}} />);
    return StyleFlat(screen.getByTestId('chat-card-delta').props.style).color;
  };

  it('is red over a spending budget and green under it', async () => {
    expect(await deltaColor('eatingout', 14)).toBe(C.bad);
    screen.unmount();
    expect(await deltaColor('eatingout', -14)).toBe(C.chatUnder);
  });

  it('is green over an Income target — earning more than planned is good news', async () => {
    expect(await deltaColor('salary', 200)).toBe(C.chatUnder);
    screen.unmount();
    expect(await deltaColor('salary', -200)).toBe(C.bad);
  });
});

// WHIT-617 — iOS keeps a shape's `%` lengths from its first draw, so a `100%` budget line stops
// short when the plot grows. The line must be measured and drawn with plain numbers.
describe('the answer card budget line', () => {
  const LENGTH_PROPS = ['width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2'];

  const expectNoPercentLengths = () => {
    for (const node of screen.UNSAFE_root.findAll(() => true)) {
      for (const prop of LENGTH_PROPS) {
        const value = node.props[prop];
        if (typeof value === 'string') expect(value).not.toMatch(/%$/);
      }
    }
  };

  const layout = (width: number) => fireEvent(screen.getByTestId('chat-card-budget-line'), 'layout', {
    nativeEvent: { layout: { width, height: 2 } },
  });

  const dashedLine = () => screen.getByTestId('chat-card-budget-line')
    .find((node) => node.props.strokeDasharray === '5 4');

  it('draws a dashed line the measured width of the plot, with no % lengths', async () => {
    await renderWithQueries(<ChatAnswer text="ok" reply={REPLY} onAction={() => {}} />);
    expectNoPercentLengths();

    layout(300);
    const line = dashedLine();
    expect(line.props).toMatchObject({ x1: 0, x2: 300, strokeWidth: 1.5, strokeOpacity: 0.7, stroke: C.text });
    expect(line.parent?.props).toMatchObject({ width: 300, height: 2 });
    expectNoPercentLengths();

    layout(200);
    expect(dashedLine().props.x2).toBe(200);
  });
});
