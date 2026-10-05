// WHIT-749 slice 1 — the hero-ink tints on the accent hero gradient come from theme tokens, not
// hand-typed rgba strings. C.heroInkSoft is the muted label ink; C.heroInkWash is the one chip /
// pill / bar-track tint. No shipped file (outside the palette home) may still type either family.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { shippedCode } from './support/sourceScan';

// Built from pieces so this file can never match its own pattern.
const HERO_INK_LITERAL = new RegExp(['rgba\\(\\s*2[01]\\s*,\\s*18\\s*,', '\\s*(50|58)\\s*,'].join(''), 'g');

describe('hero-ink colours live in the theme', () => {
  it('C.heroInkWash is the hero chip/track tint and C.heroInkSoft keeps its value', () => {
    expect((C as Record<string, string>).heroInkWash).toBe('rgba(21,18,58,.16)');
    expect(C.heroInkSoft).toBe('rgba(20,18,50,.62)');
  });

  it('no shipped screen or component hand-types a hero-ink colour', () => {
    const offenders: string[] = [];
    for (const [file, src] of shippedCode()) {
      if (file === 'src/theme.ts') continue;
      const found = src.match(HERO_INK_LITERAL)?.length ?? 0;
      if (found) offenders.push(`${file}: ${found}`);
    }
    expect(offenders).toEqual([]);
  });
});
