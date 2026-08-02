// WHIT-403 — the slice divider is now the CHART_BG ring track showing THROUGH the gap between
// wedges. That promotes CHART_BG from "a background token" to "a colour no slice may ever be": a
// wedge painted CHART_BG would vanish into its own dividers and read as a hole in the ring rather
// than as a category. Nothing else in the suite pins that, because before this card the track was a
// faint blue and a CHART_BG slice would merely have been dark.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, CHART_BG, OTHER_COLOR, ASSIGNMENT_ORDER, chartCategoryColor } from '../theme/chartColors';
import { C } from '../theme';

describe('the divider colour can never also be a slice colour', () => {
  // [Q14] REGRESSION GUARD over the whole reachable range of slice colours: every ramp entry, the
  // reserved "Other" grey, and each of the three ways chartCategoryColor resolves one (stored slot,
  // built-in id, hashed unknown id, blank id). A future ramp tweak that lands on #16161e would
  // silently delete that category from the chart.
  it('[Q14] no colour a wedge can be painted equals CHART_BG', () => {
    expect(CATEGORY_COLORS).not.toContain(CHART_BG);
    expect(OTHER_COLOR).not.toBe(CHART_BG);

    const reachable = [
      ...ASSIGNMENT_ORDER.map((_, slot) => chartCategoryColor('anything', { slot })),
      chartCategoryColor('coffee'),               // built-in id path
      chartCategoryColor('a-user-made-category'), // hashed unknown id path
      chartCategoryColor(null),                   // no id at all
    ];
    expect(reachable).not.toContain(CHART_BG);
  });
});

describe('the divider colour still disappears into the screen behind it (tripwire)', () => {
  // [Q15] TRIPWIRE, not a design rule. CHART_BG is deliberately its own token so the donut owns its
  // divider colour — but TODAY the divider is invisible only because that token happens to equal the
  // screen behind the chart. If C.bg is ever retuned and CHART_BG is not, the donut grows a solid
  // dark ring band behind the wedges (an opaque circle, unlike the translucent hairline it replaced).
  // This failing is not automatically a bug — it is a prompt to decide, on purpose, whether the
  // divider follows the new background or the donut moves onto a surface of its own.
  it('[Q15] CHART_BG still equals the screen background it is meant to disappear into', () => {
    expect(CHART_BG).toBe(C.bg);
  });
});
