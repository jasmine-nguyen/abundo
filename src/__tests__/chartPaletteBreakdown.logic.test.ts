// WHIT chart palette — the Insights breakdown selectors, fed the screen's ramp-wrapped category
// accessor, must recolour the REAL rows the palette touches and leave the synthetic/reserved ones
// alone. The Insights screen wraps `category` as `{...c, color: chartCategoryColor(id, { slot: c.colorSlot })}` (app/(tabs)/
// insights.tsx); this file feeds categoryBreakdown / incomeBreakdown that exact wrapper and pins:
//   [A4] a "Directly in X" leaf inherits its PARENT's ramp colour (never a hash of `${id}__direct`)
//   [A5] a refund line takes the refunded MEMBER's ramp colour (never a hash of `${id}__refund`)
//   [A6] the Uncategorized row stays the hard-coded C.purple (never routed through the ramp)
//   [A8] the muted income "adjustment" plug stays ADJUSTMENT_ROW's neutral tone (never recoloured)
// The real categories below carry a STORED colorSlot deliberately, and each one is pinned to the
// slot colour AND asserted to differ from its id-derived colour. Without that, the `{ slot: ... }`
// on the wrapper below would be decorative — every assertion would still pass with the slot dropped,
// and the file would claim to mirror the screen while proving nothing about the stored slot.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown, incomeBreakdown, UNCATEGORIZED_KEY } from '../context';
import { C, ADJUSTMENT_ROW } from '../theme';
import { chartCategoryColor } from '../theme/chartColors';
import { cat, spend, withRollup } from './factory';
import type { Category } from '../context';

// A plain id→Category lookup, then the Insights screen's accessor wrapper on top of it
// (mirrors insights.tsx `chartCategory` verbatim: unknown id → passthrough undefined).
function chartWrap(cats: Category[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (id: string) => {
    const c = byId.get(id);
    if (!c) return c;
    return { ...c, color: chartCategoryColor(id, { slot: c.colorSlot }) };
  };
}

describe('categoryBreakdown under the chart-palette accessor', () => {
  it('[A4] a "Directly in X" leaf inherits the parent ramp colour, not a hash of its synthetic id', () => {
    // travel is a parent with its OWN direct spend + a child petrol → a "Directly in travel" row is
    // emitted. Its colour must be the PARENT's ramp colour. travel carries a stored slot 3, which
    // resolves to a DIFFERENT hue than its id-derived one — so the leaf inheriting it proves the
    // stored slot travelled all the way through the selector, not just the id.
    const cats = [
      cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: null, colorSlot: 3 }),
      cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'travel' }),
    ];
    const breakdown = withRollup(
      { travel: spend({ posted: 20, pending: 0 }), petrol: spend({ posted: 60, pending: 0 }) },
      { nodes: { travel: { posted: 80, pending: 0 } } },
    );
    const { rows } = categoryBreakdown({ breakdown, category: chartWrap(cats) });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // parent row itself recolours to the ramp — via its STORED slot, not its id
    expect(byId['travel'].color).toBe(chartCategoryColor('travel', { slot: 3 }));
    expect(byId['travel'].color).not.toBe(chartCategoryColor('travel'));
    // the synthetic direct leaf inherits the parent's colour — NOT chartCategoryColor('travel__direct')
    expect(byId['travel__direct']).toBeDefined();
    expect(byId['travel__direct'].color).toBe(byId['travel'].color);
    expect(byId['travel__direct'].color).not.toBe(chartCategoryColor('travel__direct'));
    expect(byId['travel__direct'].drillId).toBe('travel');
  });

  it('[A5] a refund line takes the refunded members ramp colour, not a hash of `${id}__refund`', () => {
    const cats = [
      cat({ id: 'shopping', name: 'Shopping', bucket: 'Living', parent: null }),
      cat({ id: 'shoes', name: 'Shoes', bucket: 'Living', parent: 'shopping' }),
      cat({ id: 'clothes', name: 'Clothes', bucket: 'Living', parent: 'shopping', colorSlot: 8 }),
    ];
    const breakdown = withRollup(
      { shoes: spend({ posted: 100, pending: 0 }), clothes: spend({ posted: 0, pending: 0 }) },
      { nodes: { shopping: { posted: 70, pending: 0 } }, refunds: { shopping: [{ id: 'clothes', amount: -30 }] } },
    );
    const { rows } = categoryBreakdown({ breakdown, category: chartWrap(cats) });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const refund = byId['clothes__refund'];
    expect(refund).toBeDefined();
    expect(refund.color).toBe(chartCategoryColor('clothes', { slot: 8 })); // the member's ramp colour
    expect(refund.color).not.toBe(chartCategoryColor('clothes'));          // via its slot, not its id
    expect(refund.color).not.toBe(chartCategoryColor('clothes__refund'));  // NOT the synthetic-id hash
  });

  it('[A6] the Uncategorized row keeps the hard-coded C.purple, never a ramp colour', () => {
    const cats = [cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: null })];
    const breakdown = withRollup(
      { groceries: spend({ posted: 40, pending: 0 }), [UNCATEGORIZED_KEY]: spend({ posted: 25, pending: 0 }) },
      { nodes: {} },
    );
    const { rows } = categoryBreakdown({ breakdown, category: chartWrap(cats) });
    const uncat = rows.find((r) => r.id === UNCATEGORIZED_KEY)!;
    expect(uncat.color).toBe(C.purple);
    expect(uncat.color).not.toBe(chartCategoryColor(UNCATEGORIZED_KEY)); // not routed through the ramp
  });
});

describe('incomeBreakdown under the chart-palette accessor', () => {
  it('[A7-logic] a real income source recolours to its ramp slot; [A8] the muted plug stays neutral', () => {
    const cats = [cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de', colorSlot: 5 })];
    // earned 3120 vs shown 3000 → a 120 residual → one muted adjustment plug appended.
    const { rows } = incomeBreakdown({
      earned: 3120,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
      category: chartWrap(cats),
    });
    const salary = rows.find((r) => r.id === 'salary')!;
    const plug = rows.find((r) => r.muted)!;
    expect(salary.color).toBe(chartCategoryColor('salary', { slot: 5 })); // ramp, not the old '#2ac3de'
    expect(salary.color).not.toBe(chartCategoryColor('salary'));          // via its slot, not its id
    expect(salary.color).not.toBe('#2ac3de');
    expect(plug.color).toBe(ADJUSTMENT_ROW.color);            // untouched by the ramp
    expect(plug.color).not.toBe(chartCategoryColor('__earned_adjustment__'));
  });
});
