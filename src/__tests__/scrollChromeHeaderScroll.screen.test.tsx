// WHIT-200/761 — ScrollChromeHeader's scroll→state wiring. State lives in the provider, so the
// header reads/writes the shared stateRef via useNavBars and keeps no chrome state of its own.
// Covers:
//   (1) direction: down → 'hidden', a later up → 'shown' (proves it reads+writes the shared ref),
//   (2) dedup: a continued same-direction scroll doesn't re-call setNavBars.
// The slide distance, opacity and scrollEventThrottle are covered in
// scrollChromeHeaderOwnsScroll.screen.test.tsx against the real provider.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Animated, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { scrollTo } from './support/scrollChromeHeader';

// The mocked context exposes the SAME single stateRef the provider owns; setNavBars must
// write it, so the header's dedup/direction logic runs against the shared source of truth.
let mockVisibility: Animated.Value;
let mockStateRef: { current: 'shown' | 'hidden' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => ({
  useNavBars: () => ({ visibility: mockVisibility, setNavBars: mockSetNavBars, stateRef: mockStateRef }),
}));

import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

beforeEach(() => {
  mockSetNavBars.mockClear();
  mockVisibility = new Animated.Value(1);
  mockStateRef = { current: 'shown' };
});

function renderHeader() {
  return render(
    <ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>,
  );
}

it('scrolling down hides, then scrolling up shows — driving the shared stateRef', () => {
  const r = renderHeader();
  scrollTo(r, 200);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');
  scrollTo(r, 20);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
});

it('a continued same-direction scroll does not re-call setNavBars (dedups on the shared ref)', () => {
  const r = renderHeader();
  scrollTo(r, 200);   // shown → hidden (1 call, ref now 'hidden')
  scrollTo(r, 400);   // still down, already hidden → no new call
  expect(mockSetNavBars).toHaveBeenCalledTimes(1);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');
});
