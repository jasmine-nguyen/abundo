// WHIT-730 follow-up — a list row must sit inside the shared Ask-button clearance wrapper, so the
// floating Ask button never covers it, even when the list is at rest.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { expect } from '@jest/globals';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { ASK_BUTTON_RIGHT_CLEARANCE, ASK_BUTTON_EDGE, ASK_BUTTON_SIZE } from '../../chat/AskButton';
import { SCREEN_PADDING } from '../../motion/ScrollChromeHeader';

export function findAskButtonClearance(node: ReactTestInstance) {
  let host: ReactTestInstance | null = node;
  while (host && !(typeof host.type === 'string' && host.props.testID === 'ask-button-clearance')) host = host.parent;
  return host;
}

export function expectClearsAskButton(node: ReactTestInstance) {
  const host = findAskButtonClearance(node);
  expect(host).not.toBeNull();

  expect(typeof ASK_BUTTON_RIGHT_CLEARANCE).toBe('number');
  const { paddingRight } = StyleSheet.flatten(host!.props.style);
  expect(paddingRight).toBe(ASK_BUTTON_RIGHT_CLEARANCE);
  expect(ASK_BUTTON_RIGHT_CLEARANCE).toBeGreaterThanOrEqual(ASK_BUTTON_SIZE);
  // The row's right edge stops short of the button's lane (its edge offset + its width).
  expect(SCREEN_PADDING + ASK_BUTTON_RIGHT_CLEARANCE).toBeGreaterThan(ASK_BUTTON_EDGE + ASK_BUTTON_SIZE);
}
