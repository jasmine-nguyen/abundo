// WHIT-721 QA — seeding the shared GROCERIES_RECORD shows the app the same category the old
// per-file seed copies did.
import { describe, it, expect } from '@jest/globals';
import { toCategory } from '../model';
import { colorForCategory } from '../categoryColors';
import { GROCERIES_RECORD } from './support/categories';

describe('WHIT-721 QA: the shared Groceries record', () => {
  // [A1] The removed copies differed only in colour / parent / recent: 0, which the app's reader
  // ignores or defaults. The shared record must read back as that same category: Living bucket, cart icon, recent 0.
  it('reads back through toCategory exactly as the old seed copies did', () => {
    const expected = {
      id: 'groceries',
      name: 'Groceries',
      bucket: 'Living',
      icon: 'cart',
      color: colorForCategory('groceries'),
      recent: 0,
      parent: null,
      colorSlot: undefined,
    };
    const oldShapes = [
      { ...GROCERIES_RECORD, color: '#7FD49B', parent: null },
      { ...GROCERIES_RECORD, color: '#7fd49b', recent: 0 },
      { ...GROCERIES_RECORD, parent: null },
    ];

    expect(toCategory(GROCERIES_RECORD)).toEqual(expected);
    oldShapes.forEach((shape) => expect(toCategory(shape)).toEqual(expected));
  });
});
