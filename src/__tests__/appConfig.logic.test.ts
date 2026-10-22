// ABU-118 — app.json's iOS window settings. The iPhone full-screen flag makes iOS letterbox the app
// into a narrow upright window on the Duo's inner (resizable-window) screen instead of letting it
// turn sideways into two panes. The portrait lock stays so normal iPhones and the outer screen stay upright.
import { it, expect } from '@jest/globals';
import appJson from '../../app.json';

it('lets the resizable-window screen turn sideways (no full-screen flag) and keeps the portrait lock', () => {
  const { expo } = appJson as { expo: { orientation?: string; ios?: Record<string, unknown> } };
  expect(expo.orientation).toBe('portrait');
  expect(expo.ios?.requireFullScreen ?? false).toBe(false);
});
