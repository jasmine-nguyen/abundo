// Screen test (WHIT-74): the global "couldn't load" read-error banner inside
// <Overlays/>. This is the GAP the provider tests can't reach — the banner's actual
// render + Retry wiring — driven by a hand-built partial AppContext (null-safe
// siblings), matching the PayCycleSheet.screen.test pattern. Locks: the banner + copy
// show ONLY when loadError is true (guards the `if (!loadError) return null` early
// return), and tapping Retry calls retryLoad.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

import { Overlays } from '../components/Overlays';

const retryLoad = jest.fn();

// Partial context: enough for every child <Overlays/> renders (LoadErrorBanner,
// NotifBanner, Toast, SheetHost) to render null-safe.
function bannerState(loadError: boolean): AppContext {
  return {
    loadError,
    retryLoad,
    toast: null,
    notif: null,
    sheet: null,
    dismissNotif: jest.fn(),
    setSheet: jest.fn(),
  } as unknown as AppContext;
}

beforeEach(() => {
  retryLoad.mockClear();
});

it('shows the banner + offline copy + Retry when loadError is true', () => {
  mockState = bannerState(true);
  render(<Overlays />);
  expect(screen.getByTestId('loadErrorBanner')).toBeTruthy();
  // Straight apostrophe + em dash (U+2014) — must match Overlays.tsx exactly.
  expect(screen.getByText('Couldn\'t load — you may be offline')).toBeTruthy();
  expect(screen.getByTestId('loadErrorRetry')).toBeTruthy();
});

it('renders nothing for the banner when loadError is false', () => {
  mockState = bannerState(false);
  render(<Overlays />);
  expect(screen.queryByTestId('loadErrorBanner')).toBeNull();
  expect(screen.queryByTestId('loadErrorRetry')).toBeNull();
});

it('tapping Retry calls retryLoad exactly once', () => {
  mockState = bannerState(true);
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('loadErrorRetry'));
  expect(retryLoad).toHaveBeenCalledTimes(1);
});
