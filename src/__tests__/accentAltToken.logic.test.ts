// WHIT-398 — C.accentAlt is the app's SECOND blue: add buttons, dashed "new X" rows, retry pills,
// the Insights cycle toggle. It was written out as the raw string 'rgba(124,140,255,...)' in 52
// places before this card. The whole point of the token is that it is NOT a shade of C.accent, so
// the two things worth pinning are its exact value and its distance from the accent it looks like.
// The same card also made the two hairlines derive from the accent instead of being hand-written
// copies of it — [Q18] is what stops them being pasted back.
import { describe, it, expect } from '@jest/globals';
import { C, tint } from '../theme';

describe('the chip blue keeps its exact value', () => {
  // [Q16] VALUE PIN. Every call site now derives its colour from this one hex, so a typo here
  // repaints 52 surfaces at once and no screen test would name the culprit.
  it('[Q16] C.accentAlt is #7c8cff and still renders the pre-token rgba', () => {
    expect(C.accentAlt).toBe('#7c8cff');
    expect(tint(C.accentAlt, 0.16)).toBe('rgba(124,140,255,0.16)');
  });
});

describe('the chip blue is still a different blue from the accent (tripwire)', () => {
  // [Q17] TRIPWIRE, not a design rule. accentAlt sits in the accent* block and reads like a shade
  // of C.accent, but it is a different hue: #7c8cff = rgb(124,140,255) vs #7aa2f7 = rgb(122,162,247).
  // The card exists because "tidying" tint(C.accentAlt, a) into tint(C.accent, a) repaints it a
  // greener blue with nothing to catch it — this is what catches it.
  // This failing is not automatically a bug. It is a prompt to decide, on purpose, whether the app
  // should have two brand blues at all, or whether these two should finally merge.
  it('[Q17] accentAlt and accent do not resolve to the same colour', () => {
    expect(C.accentAlt).not.toBe(C.accent);
    expect(tint(C.accentAlt, 0.16)).not.toBe(tint(C.accent, 0.16));
  });
});

describe('the hairlines are DERIVED from the accent, not copies of it', () => {
  // [Q18] The inverse of [Q17], and the other half of WHIT-398. Unlike accentAlt, both hairlines
  // genuinely ARE the accent — but until this card they were hand-typed rgba strings, so repainting
  // C.accent would have left every card border in the app on the old blue with nothing to notice.
  // What this locks: the hairlines and C.accent can never DIVERGE. It does NOT detect a literal
  // pasted back in tint()'s own output format — that only reddens the moment someone repaints
  // C.accent, which is the moment it becomes a visible bug. The two value pins below are the
  // other half: an intentional repaint has to be declared here.
  it('[Q18] hairline and hairlineStrong are exactly the accent at 10% and 16%', () => {
    expect(C.hairline).toBe(tint(C.accent, 0.1));
    expect(C.hairlineStrong).toBe(tint(C.accent, 0.16));
    // and the values themselves are unchanged from the literals they replaced
    expect(C.hairline).toBe('rgba(122,162,247,0.1)');
    expect(C.hairlineStrong).toBe('rgba(122,162,247,0.16)');
  });
});
