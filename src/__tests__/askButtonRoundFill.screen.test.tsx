// WHIT-704 QA — the round Ask button keeps its look: the gradient fill is clipped to the circle
// inside the 1px ring (WHIT-615), the icon is the unchanged 22pt dark chat-sparkle, and the
// circle still fits inside the list clearance above the tab bar.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';

jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider } from '../chat/ChatContext';
import { ASK_BUTTON_BOTTOM_CLEARANCE } from '../motion/useNavBarsHeader';
import { installFakeServer } from './support/fakeServer';
import { tabBarProps } from './support/tabBar';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const barProps = tabBarProps();

const flat = (style: unknown) => Object.assign({}, ...[style].flat(3).filter(Boolean));

async function renderButton() {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);
  return screen.getByLabelText('Ask about your spending');
}

// [A1]
it('clips the gradient to the circle inside the 1px ring, with the accent → purple diagonal', async () => {
  const button = await renderButton();
  const buttonStyle = flat(button.props.style);

  const fill = button.findAll((node) => typeof node.type === 'string' && flat(node.props.style).overflow === 'hidden')[0];
  expect(fill).toBeTruthy();
  expect(flat(fill.props.style).borderRadius).toBe(buttonStyle.borderRadius - buttonStyle.borderWidth);
  expect(flat(fill.props.style).borderRadius).toBe(23);
  // The button itself must not clip, or the shadow disappears.
  expect(buttonStyle.overflow).toBeUndefined();

  const stopColors = button.findAll((node) => node.props.stopColor !== undefined && typeof node.type === 'string')
    .map((node) => node.props.stopColor);
  expect(stopColors).toEqual(['#7aa2f7', '#bb9af7']);
  const gradient = button.findAll((node) => node.props.id === 'askGradient' && typeof node.type === 'string')[0];
  expect(gradient.props).toMatchObject({ x1: '0', y1: '0', x2: 1, y2: 1 });
});

// [A2]
it('shows only the 22pt dark chat-sparkle icon inside the circle', async () => {
  const button = await renderButton();
  const icons = button.findAll((node) => typeof node.props.xml === 'string' && typeof node.type === 'string');
  expect(icons).toHaveLength(1);
  expect(icons[0].props).toMatchObject({ width: 22, height: 22 });
  expect(icons[0].props.xml).toContain('#16161e');
  expect(icons[0].props.xml).toContain('1.9');
});

// [A3]
it('the circle sits inside the extra list clearance, so the last row can scroll above it', async () => {
  const button = await renderButton();
  const style = flat(button.props.style);
  const barHeight = 90;
  const topAboveBar = style.bottom - barHeight + style.height;
  expect(topAboveBar).toBeLessThanOrEqual(ASK_BUTTON_BOTTOM_CLEARANCE);
});
