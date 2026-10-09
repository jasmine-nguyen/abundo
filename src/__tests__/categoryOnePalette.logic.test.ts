// WHIT-836: one category colour palette everywhere. A loaded category's `color` (which Budgets,
// Transactions and pickers paint) is the same colour Insights paints: chartCategoryColor, keyed on
// the stored colour slot, with the id fallback when there's no slot. The server-sent hex is ignored.
import { describe, it, expect } from '@jest/globals';
import { toCategory } from '../model';
import { chartCategoryColor } from '../chartColors';
import { COFFEE_RECORD } from './support/categories';

describe('toCategory — a category is the same colour on every screen', () => {
  const custom = { id: 'my-custom-cat', name: 'Pottery', bucket: 'Lifestyle', icon: 'coffee' };

  it.each([
    ['a built-in with a stored slot', { ...COFFEE_RECORD, colorSlot: 4 }, 4],
    ['a built-in on slot 0', { ...COFFEE_RECORD, colorSlot: 0 }, 0],
    ['a built-in with no slot', COFFEE_RECORD, undefined],
    ['a custom category with no slot', custom, undefined],
    ['a custom category with a stored slot', { ...custom, colorSlot: 11 }, 11],
    ['a server-sent hex, which is ignored', { ...COFFEE_RECORD, color: '#E8A87C' }, undefined],
  ])('%s → the Insights chart colour', (_label, raw, slot) => {
    expect(toCategory(raw).color).toBe(chartCategoryColor(raw.id, { slot }));
  });
});
