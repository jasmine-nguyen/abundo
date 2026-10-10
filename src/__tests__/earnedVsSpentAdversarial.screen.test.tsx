// WHIT-324 (qa adversarial) — the EPS/round boundary: a leftover under the $1 rounding threshold
// must read as broke-even, never a contradictory "+$0 surplus" / "−$0 deficit".
import { describe, it, expect } from '@jest/globals';
import { earnedVsSpent } from '../components/EarnedVsSpent';

describe('earnedVsSpent — sub-dollar rounding boundary [G2]', () => {
  // Classification tracks the WHOLE-DOLLAR amount the card shows (Math.round), so any leftover that
  // displays as "$0" reads as broke-even, while a genuine whole-dollar gap still reads as a deficit.
  it.each([
    { name: 'a sub-$1 positive leftover reads as broke-even (shows $0, not a phantom surplus)', earned: 100.3, spent: 100, even: true, tone: 'neutral', amountLabel: '$0' },
    { name: 'a sub-$1 negative leftover reads as broke-even (shows $0, not a phantom deficit)', earned: 100, spent: 100.3, even: true, tone: 'neutral', amountLabel: '$0' },
    { name: 'a clear $1+ overspend reads as a real deficit', earned: 100, spent: 101, even: false, tone: 'bad', amountLabel: '−$1 deficit' },
  ])('$name', ({ earned, spent, even, tone, amountLabel }) => {
    const r = earnedVsSpent(earned, spent);
    expect(r.even).toBe(even);
    expect(r.tone).toBe(tone);
    expect(r.amountLabel).toBe(amountLabel);
  });
});
