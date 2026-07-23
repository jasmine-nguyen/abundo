// WHIT-326: pin every category colour to its INTENDED warm/cool class. The donut arranges slices
// by `temperature(hex)` (WHIT-323); if a future recolour drifts a category across the hue/
// saturation boundary, the ring would silently re-clump. This test writes the intended class down
// by hand — independently of the hue math the code uses — so a bad recolour fails loudly instead of
// the test agreeing with the drift. Covers all 13 CATEGORY_BASE hues AND their 13 darker siblings.
// (temperature lives in SpendingDonut.tsx, which pulls the react-native-svg graph → screen project.)
import { describe, it, expect } from '@jest/globals';
import { temperature } from '../components/SpendingDonut';
import { CATEGORY_BASE, CATEGORY_SIBLINGS } from '../context';

// The source of truth, authored by intent (NOT derived from the hue math). Warm: the reds/oranges/
// gold/pink categories; cool: greens/teals/blues/purples. A recolour that flips any of these must
// update this map on purpose — that's the loud failure the card asks for.
const INTENDED: Record<string, 'warm' | 'cool'> = {
  coffee: 'warm', eatingout: 'warm', health: 'warm', utilities: 'warm',
  groceries: 'cool', transport: 'cool', pets: 'cool', shopping: 'cool', fitness: 'cool',
  subs: 'cool', travel: 'cool', gifts: 'cool', phonenet: 'cool',
};

// Tightest margins in today's palette (computed with the code's math), noted so a future recolour
// reviewer sees which categories sit near a boundary:
//   • groceries base #9ece6a is only ~8.8° past the 80° warm/cool cutoff (hue 88.8° → cool).
//   • groceries sibling #7da64f has saturation ~0.355, the closest of all 26 to the 0.25 neutral
//     cutoff. Everything else clears its boundary comfortably (eatingout/health ~340–352°).

describe('WHIT-326: category palette warm/cool classification', () => {
  it('the intended map covers exactly the CATEGORY_BASE ids (a new category must be added here)', () => {
    expect(Object.keys(CATEGORY_BASE)).toHaveLength(13);
    expect(CATEGORY_SIBLINGS).toHaveLength(Object.keys(CATEGORY_BASE).length);
    expect(Object.keys(INTENDED).sort()).toEqual(Object.keys(CATEGORY_BASE).sort());
  });

  it.each(Object.entries(CATEGORY_BASE))('base %s classifies as its intended temperature', (id, hex) => {
    expect(temperature(hex)).toBe(INTENDED[id]);
  });

  it.each(Object.keys(CATEGORY_BASE).map((id, i) => [id, CATEGORY_SIBLINGS[i]] as const))(
    'sibling of %s inherits its base\'s intended temperature',
    (id, siblingHex) => {
      expect(temperature(siblingHex)).toBe(INTENDED[id]);
    },
  );

  it('no base or sibling colour is neutral — only the grey "Other" slice may be', () => {
    for (const hex of Object.values(CATEGORY_BASE)) expect(temperature(hex)).not.toBe('neutral');
    for (const hex of CATEGORY_SIBLINGS) expect(temperature(hex)).not.toBe('neutral');
  });
});
