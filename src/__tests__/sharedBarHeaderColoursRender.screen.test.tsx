// WHIT-708 QA — what actually renders: every screen title is the same off-white, and the
// budget bar and the plain bar sit on the same single rail shade.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { styleOf } from './support/layout';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { C } from '../theme';
import { Header } from '../components/Header';
import { Glyph } from '../icons';
import { BudgetBar, Bar } from '../components/ui';

// [A1] pushed-screen title uses the theme's brightest text, not pure white (decision 2A)
it('the pushed-screen header title is the theme off-white', () => {
  render(<Header title="Coffee" />);
  expect(styleOf(screen.getByText('Coffee')).color).toBe(C.textBright);
});

// WHIT-814: the back arrow uses the shared header button's accent, not a raw white glyph
it('the pushed-screen back arrow uses the theme accent', () => {
  const { UNSAFE_getByType } = render(<Header title="Coffee" />);
  expect(UNSAFE_getByType(Glyph).props.color).toBe(C.accentSoft);
});

// [A2] one rail shade: BudgetBar's track, Bar's default track and the theme token all match
it('budget bars and plain bars share the single theme rail colour; the today tick is the theme tick', () => {
  const backgrounds = (el: React.ReactElement) => {
    const { UNSAFE_getAllByType, unmount } = render(el);
    const colours = UNSAFE_getAllByType(View).map((v) => styleOf(v).backgroundColor);
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
