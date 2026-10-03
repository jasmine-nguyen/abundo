// WHIT-708 QA — what actually renders: every screen title is the same off-white, and the
// budget bar and the plain bar sit on the same single rail shade.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

import { C } from '../theme';
import { Header } from '../components/Header';
import { BudgetBar, Bar } from '../components/ui';

function colourOf(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never)?.color;
}

// [A1] pushed-screen title uses the theme's brightest text, not pure white (decision 2A)
it('the pushed-screen header title is the theme off-white', () => {
  render(<Header title="Coffee" />);
  expect(colourOf(screen.getByText('Coffee'))).toBe(C.textBright);
});

// [A2] one rail shade: BudgetBar's track, Bar's default track and the theme token all match
it('budget bars and plain bars share the single theme rail colour; the today tick is the theme tick', () => {
  const backgrounds = (el: React.ReactElement) => {
    const { UNSAFE_getAllByType, unmount } = render(el);
    const colours = UNSAFE_getAllByType(View).map((v) => StyleSheet.flatten(v.props.style)?.backgroundColor);
    unmount();
    return colours;
  };
  const budget = backgrounds(<BudgetBar postedPct={10} pendingPct={5} targetPct={50} postedColor="#123456" pendingTint="#654321" />);
  const plain = backgrounds(<Bar pct={30} color="#123456" />);

  expect(budget).toContain(C.progressTrack);
  expect(budget).toContain(C.progressTick);
  expect(plain).toContain(C.progressTrack);
  expect(C.progressTrack).toBe('rgba(255,255,255,.07)');
});
