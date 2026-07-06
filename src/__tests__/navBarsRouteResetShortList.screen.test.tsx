// WHIT-200 GAP — the WHIT-184 hook reset also covered "re-entering a short, unscrollable
// list" (its comment: reset on focus "so hiding on one tab never leaves the header/tab bar
// stranded hidden when you switch tabs or land on a short list"). That reset moved to
// NavBarsRouteReset. The implementer's navBarsRouteReset test proves the detail push/pop
// case; this locks the OTHER half the old focus-reset owned:
//   (1) a plain TAB->TAB switch (e.g. Budgets -> Insights, an UNWIRED short-list screen with
//       no scroll hook of its own) re-shows the bars — route reset is the ONLY thing that can,
//   (2) hidden immediately before a route change still ends 'shown' (the reset wins the race).
// reduceMotion:true so setNavBars snaps synchronously via setValue.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, act } from '@testing-library/react-native';

let mockPathname = '/budgets';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));

import { NavBarsProvider, useNavBars } from '../motion/NavBarsContext';
import { NavBarsRouteReset } from '../motion/NavBarsRouteReset';

let captured: ReturnType<typeof useNavBars>;
function Probe() { captured = useNavBars(); return null; }

// Fresh element each call so React re-renders NavBarsRouteReset and re-reads usePathname.
const tree = () => (
  <NavBarsProvider reduceMotion={true}>
    <NavBarsRouteReset />
    <Probe />
  </NavBarsProvider>
);
const visValue = () => (captured.visibility as unknown as { __getValue(): number }).__getValue();

beforeEach(() => { mockPathname = '/budgets'; });

it('a tab->tab switch onto an unwired short-list screen re-shows the bars', () => {
  const view = render(tree());
  act(() => captured.setNavBars('hidden'));        // bars hidden on Budgets (a long list)
  expect(visValue()).toBe(0);

  mockPathname = '/insights';                       // switch to a short, unscrollable tab
  view.rerender(tree());
  expect(visValue()).toBe(1);                       // re-shown by the route reset alone
});

it('a hide immediately before a route change still ends shown (reset wins)', () => {
  const view = render(tree());
  act(() => {
    captured.setNavBars('hidden');                  // last-gasp scroll-hide...
    mockPathname = '/transactions';                 // ...then a route change lands
  });
  view.rerender(tree());
  expect(visValue()).toBe(1);
});
