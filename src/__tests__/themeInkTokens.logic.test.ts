// WHIT-400 — C.accentInk and C.heroInk are both the screen background's hex (#16161e) with nothing
// tying them to it. Same shape as the OTHER_COLOR gap this card was filed for, but with a sharper
// consequence: these two are INK, drawn on the accent-blue buttons and the hero gradient. If C.bg
// is retuned and they follow by accident — or fail to follow when they should — the damage is
// unreadable text on a bright surface, not a slightly-off wedge.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';

describe('the ink tokens still match the background hex they were copied from (tripwire)', () => {
  // [Q22] TRIPWIRE, not a design rule — same contract as [Q15]/[Q19]. accentInk is chosen to be
  // legible ON the accent blue; C.bg is chosen to be a good screen surface. They are equal today
  // by coincidence. Retuning the background is NOT a reason to repaint button ink, and this failing
  // is the prompt to decide which of the two actually needed to move.
  it('[Q22] accentInk still equals C.bg', () => {
    expect(C.accentInk).toBe(C.bg);
  });

  // [Q23] Same for the hero gradient's ink. Note heroInk2 (#1a1b26) is deliberately NOT this hex
  // and is not pinned — it is the second, lighter ink and has no background twin.
  it('[Q23] heroInk still equals C.bg', () => {
    expect(C.heroInk).toBe(C.bg);
  });

  // Both `toBe` comparisons above pass if BOTH sides are undefined, so pin that the tokens exist
  // and are real hexes. A rename refactor that updates its own call sites would otherwise leave
  // this file green with the tokens gone.
  it('[Q24] the pinned ink tokens are real hex values, so the comparisons cannot pass vacuously', () => {
    expect(C.accentInk).toMatch(/^#[0-9a-f]{6}$/);
    expect(C.heroInk).toMatch(/^#[0-9a-f]{6}$/);
    expect(C.bg).toMatch(/^#[0-9a-f]{6}$/);
  });
});
