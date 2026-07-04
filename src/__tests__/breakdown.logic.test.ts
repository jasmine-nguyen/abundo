// categoryBreakdown selector (WHIT-23): shapes the /breakdown map into sorted rows
// for the Insights tab. Pure over { breakdown, category }, so it runs headlessly via
// makeState. This is the single testable unit driving the screen.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown, UNCATEGORIZED_KEY } from '../context';
import { makeState, cat, spend } from './factory';

const cats = [
  cat({ id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C' }),
  cat({ id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7FD49B' }),
];

describe('categoryBreakdown', () => {
  it('joins spend with the taxonomy and sorts highest-spend first', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 20, pending: 0 }),     // 20
        groceries: spend({ posted: 80, pending: 10 }), // 90
      },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => r.id)).toEqual(['groceries', 'coffee']); // desc by spent
    expect(rows[0].name).toBe('Groceries');
    expect(rows[0].spent).toBe(90);
    expect(rows[1].spent).toBe(20);
    expect(total).toBe(110);
  });

  it('shows the pending portion in spentLabel only when pending > 0', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 20, pending: 5 }),
        groceries: spend({ posted: 30, pending: 0 }),
      },
    });
    const rows = categoryBreakdown(s).rows;
    const coffee = rows.find((r) => r.id === 'coffee')!;
    const groceries = rows.find((r) => r.id === 'groceries')!;
    expect(coffee.spentLabel).toContain('pending');
    expect(groceries.spentLabel).not.toContain('pending');
  });

  it('renders the Uncategorized bucket with its own styling', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 40, pending: 0 }),
        [UNCATEGORIZED_KEY]: spend({ posted: 25, pending: 0 }),
      },
    });
    const uncat = categoryBreakdown(s).rows.find((r) => r.id === UNCATEGORIZED_KEY)!;
    expect(uncat).toBeTruthy();
    expect(uncat.name).toBe('Uncategorized');
    expect(uncat.uncategorized).toBe(true);
    expect(uncat.icon).toBe('q');
    expect(uncat.color).toBe('#c9b3f5');
  });

  it('drops zero/negative-spend rows and excludes them from the total', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 40, pending: 0 }),
        groceries: spend({ posted: 0, pending: 0 }), // clamped-to-zero server row
      },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => r.id)).toEqual(['coffee']);
    expect(total).toBe(40);
  });

  it('skips a real category id missing from the taxonomy (defensive)', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 40, pending: 0 }),
        gone: spend({ posted: 99, pending: 0 }), // not the sentinel, not in taxonomy
      },
    });
    const rows = categoryBreakdown(s).rows;
    expect(rows.map((r) => r.id)).toEqual(['coffee']);
  });

  it('pct is each row share of the total', () => {
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 25, pending: 0 }),
        groceries: spend({ posted: 75, pending: 0 }),
      },
    });
    const rows = categoryBreakdown(s).rows;
    expect(rows.find((r) => r.id === 'groceries')!.pct).toBeCloseTo(75, 5);
    expect(rows.find((r) => r.id === 'coffee')!.pct).toBeCloseTo(25, 5);
  });

  it('is empty for an empty breakdown', () => {
    const { rows, total } = categoryBreakdown(makeState({ categories: cats, breakdown: {} }));
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });

  it('renders a breakdown that is only the Uncategorized bucket', () => {
    const s = makeState({
      categories: cats,
      breakdown: { [UNCATEGORIZED_KEY]: spend({ posted: 30, pending: 10 }) },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => r.id)).toEqual([UNCATEGORIZED_KEY]);
    expect(total).toBe(40);
    expect(rows[0].pct).toBeCloseTo(100, 5);
    expect(rows[0].uncategorized).toBe(true);
  });

  it('keeps insertion order for equal-spend rows (stable sort)', () => {
    // Two categories with identical spend must not swap between renders. Insertion
    // order = Object.entries order of the server map; a stable sort preserves it.
    const s = makeState({
      categories: [
        cat({ id: 'aaa', name: 'Alpha' }),
        cat({ id: 'bbb', name: 'Bravo' }),
      ],
      breakdown: {
        aaa: spend({ posted: 50, pending: 0 }),
        bbb: spend({ posted: 50, pending: 0 }),
      },
    });
    expect(categoryBreakdown(s).rows.map((r) => r.id)).toEqual(['aaa', 'bbb']);
  });

  it('sorts the Uncategorized bucket by spend among the rows (not pinned)', () => {
    // Uncategorized is a normal row for sorting: highest spend wins, wherever it is.
    const s = makeState({
      categories: cats,
      breakdown: {
        coffee: spend({ posted: 10, pending: 0 }),               // 10
        [UNCATEGORIZED_KEY]: spend({ posted: 90, pending: 0 }),  // 90 -> first
        groceries: spend({ posted: 40, pending: 0 }),            // 40 -> middle
      },
    });
    expect(categoryBreakdown(s).rows.map((r) => r.id)).toEqual([
      UNCATEGORIZED_KEY, 'groceries', 'coffee',
    ]);
  });
});
