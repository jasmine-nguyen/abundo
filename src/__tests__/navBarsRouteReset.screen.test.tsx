// WHIT-200 — NavBarsRouteReset is the single owner of the "reset bars to shown"
// lifecycle. It replaces the old split reset (a per-screen focus effect + a tab-index
// effect on the TabBar), and unlike either it fires on ANY route change — a tab switch
// OR a detail push/pop (the case the WHIT-184 TabBar reset missed: Budgets → scroll to
// hide → open a budget detail → back would strand the bars hidden).
//
// Drives the REAL NavBarsProvider + NavBarsRouteReset (reduceMotion:true so setNavBars
// snaps synchronously via setValue). Fail-on-revert: drop the useEffect in
// NavBarsRouteReset (or stop rendering it) and the re-show assertion flips.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, act } from '@testing-library/react-native';

let mockPathname = '/budgets';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));

import { NavBarsProvider, useNavBars } from '../motion/NavBarsContext';
import { NavBarsRouteReset } from '../motion/NavBarsRouteReset';

let captured: ReturnType<typeof useNavBars>;
function Probe() {
  captured = useNavBars();
  return null;
}

// A FRESH element each call — reusing one constant element makes React bail out of
// re-rendering NavBarsRouteReset on rerender, so usePathname wouldn't be re-read.
const tree = () => (
  <NavBarsProvider reduceMotion={true}>
    <NavBarsRouteReset />
    <Probe />
  </NavBarsProvider>
);

const visValue = () => (captured.visibility as unknown as { __getValue(): number }).__getValue();

beforeEach(() => { mockPathname = '/budgets'; });

it('re-shows the nav bars on a route change (detail push/pop)', () => {
  const view = render(tree());
  // Simulate scroll-hiding the bars on the current screen.
  act(() => captured.setNavBars('hidden'));
  expect(visValue()).toBe(0);

  // Push a detail route: pathname changes → the reset fires → bars come back.
  mockPathname = '/budget/1';
  view.rerender(tree());
  expect(visValue()).toBe(1);

  // Hide again, then pop back to the tab: pathname changes again → re-shown.
  act(() => captured.setNavBars('hidden'));
  expect(visValue()).toBe(0);
  mockPathname = '/budgets';
  view.rerender(tree());
  expect(visValue()).toBe(1);
});

it('leaves the bars alone while the route is unchanged (a hide is not undone mid-screen)', () => {
  render(tree());
  act(() => captured.setNavBars('hidden')); // scroll-hide, same route
  expect(visValue()).toBe(0);               // stays hidden — no spurious reset
});
