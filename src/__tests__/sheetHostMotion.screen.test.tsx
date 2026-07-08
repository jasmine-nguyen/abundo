// WHIT-199 GAP — SheetHost reduce-motion WIRING (Overlays.tsx), the half sheetMotion.screen.test.ts
// can't reach: springSheetIn is unit-tested, but nothing proves SheetHost wires useReduceMotion →
// the Modal's animationType AND kicks the open spring (and re-kicks it on every reopen). Native-
// driver values don't advance in jest, so we assert the BRANCH/WIRING (animationType + that a
// spring was started / suppressed), never motion frames. Fail-on-revert:
//   - revert `animationType={reduceMotion ? 'none' : 'fade'}` to the old 'slide' → both asserts flip
//   - drop the open-effect's springSheetIn call → "spring on open" flips
//   - break the effect's `open` re-fire → the reopen count flips
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Modal, Animated } from 'react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

// The gate under test. Controllable so both branches are deterministic (the real hook resolves
// async off a native probe — no good for a branch assertion).
let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import { Overlays } from '../components/Overlays';

function paycycleState(): AppContext {
  return {
    sheet: { mode: 'paycycle' },
    toast: null,
    notif: null,
    payCycle: { length: 14, last_pay_date: '2026-06-06' },
    dismissNotif: jest.fn(),
    setSheet: jest.fn(),
    setPayCycleLength: jest.fn(),
    setPayday: jest.fn(),
  } as unknown as AppContext;
}
function closedState(): AppContext {
  return { ...paycycleState(), sheet: null } as AppContext;
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReduceMotion = false;
});

it('motion on: Modal fades (not slides) and the open spring is started, content mounted', () => {
  mockReduceMotion = false;
  const springSpy = jest.spyOn(Animated, 'spring')
    .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
  mockState = paycycleState();
  const { UNSAFE_getByType } = render(<Overlays />);
  expect(UNSAFE_getByType(Modal).props.animationType).toBe('fade'); // NOT the old 'slide'
  expect(screen.getByText('Fortnightly')).toBeTruthy();             // sheet content mounted
  expect(springSpy).toHaveBeenCalledTimes(1);                       // the open spring fired
});

it('reduce-motion: Modal does not animate and NO spring is started (instant jump)', () => {
  mockReduceMotion = true;
  const springSpy = jest.spyOn(Animated, 'spring');
  mockState = paycycleState();
  const { UNSAFE_getByType } = render(<Overlays />);
  expect(UNSAFE_getByType(Modal).props.animationType).toBe('none');
  expect(screen.getByText('Fortnightly')).toBeTruthy(); // still rendered immediately
  expect(springSpy).not.toHaveBeenCalled();
});

it('toggling reduce-motion while a sheet is OPEN does not re-seed/re-spring it (qa edge #2)', () => {
  // Sheet opens under reduce-motion (instant, no spring). The user then flips reduce-motion OFF
  // while the sheet stays open — the spring is keyed on `open`, not reduceMotion, so an at-rest
  // sheet must NOT suddenly spring under them. Fail-on-revert: put reduceMotion back in the open
  // effect's deps and this rerun springs → the count flips to 1.
  mockReduceMotion = true;
  const springSpy = jest.spyOn(Animated, 'spring')
    .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
  mockState = paycycleState();
  const { rerender } = render(<Overlays />);
  expect(springSpy).not.toHaveBeenCalled();  // opened under reduce-motion → no spring
  mockReduceMotion = false;                   // OS reduce-motion flipped OFF, sheet still open
  rerender(<Overlays />);
  expect(springSpy).not.toHaveBeenCalled();  // at-rest sheet is not re-sprung
});

it('reopen still springs — the open effect re-fires on every open (not stuck at rest)', () => {
  mockReduceMotion = false;
  const springSpy = jest.spyOn(Animated, 'spring')
    .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
  mockState = closedState();
  const { rerender } = render(<Overlays />);
  expect(springSpy).not.toHaveBeenCalled();   // closed → no spring
  mockState = paycycleState();
  rerender(<Overlays />);
  expect(springSpy).toHaveBeenCalledTimes(1); // first open
  mockState = closedState();
  rerender(<Overlays />);
  mockState = paycycleState();
  rerender(<Overlays />);
  expect(springSpy).toHaveBeenCalledTimes(2); // reopen re-seeds + springs
});
