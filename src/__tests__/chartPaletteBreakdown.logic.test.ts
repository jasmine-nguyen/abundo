// WHIT chart palette — the Insights breakdown selectors, fed a category accessor whose colours come
// from the ramp, must recolour the REAL rows the palette touches and leave the synthetic/reserved
// ones alone. toCategory sets every Category.color to `chartCategoryColor(id, { slot: colorSlot })`
// (WHIT-836); this file feeds categoryBreakdown a wrapper applying that same rule
// and pins:
//   [A4] a "Directly in X" leaf inherits its PARENT's ramp colour (never a hash of `${id}__direct`)
//   [A5] a refund line takes the refunded MEMBER's ramp colour (never a hash of `${id}__refund`)
// The real categories below carry a STORED colorSlot deliberately, and each one is pinned to the
// slot colour AND asserted to differ from its id-derived colour. Without that, the `{ slot: ... }`
// on the wrapper below would be decorative — every assertion would still pass with the slot dropped,
// and the file would prove nothing about the stored slot.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown } from '../context';
import { chartCategoryColor } from '../chartColors';
import { cat, spend, withRollup } from './factory';
import type { Category } from '../types';

// A plain id→Category lookup whose colour follows toCategory's colour rule (slot first, id
// fallback); unknown id → passthrough undefined.
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
});

