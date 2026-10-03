/// <reference types="node" />
// WHIT-708 — the shared progress bars and the scrolling tab header take every colour from the
// theme: no hand-typed colours left in ui.tsx or ScrollChromeHeader.tsx, one bar background shade.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { RAW_COLOR_SOURCE, shippedCode } from './support/sourceScan';

const RAW_COLOR = new RegExp(RAW_COLOR_SOURCE, 'g');
const code = shippedCode();

describe('shared bars and the tab header use only theme colours (WHIT-708)', () => {
  it.each(['src/components/ui.tsx', 'src/motion/ScrollChromeHeader.tsx'])(
    '%s has no hand-typed colours',
    (file) => {
      const src = code.get(file);
      expect(src).toBeDefined();
      expect(src!.match(RAW_COLOR) ?? []).toEqual([]);
    },
  );

  it('the theme has one bar background shade (the fainter one) and a token for the "today" tick', () => {
    expect(C.progressTrack).toBe('rgba(255,255,255,.07)');
    expect((C as Record<string, unknown>).progressTick).toBe('rgba(255,255,255,.85)');
  });
});
