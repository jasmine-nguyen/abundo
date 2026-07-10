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

  it('leaf-only rows carry depth 0 / no parent / no children (flat regression)', () => {
    const s = makeState({
      categories: cats,
      breakdown: { coffee: spend({ posted: 20, pending: 0 }), groceries: spend({ posted: 80, pending: 0 }) },
    });
    for (const r of categoryBreakdown(s).rows) {
      expect(r).toMatchObject({ depth: 0, parentId: null, hasChildren: false });
    }
  });
});

// --- sub-category drill-down tree (WHIT-226) --------------------------------

describe('categoryBreakdown — parent rollup + drill-down', () => {
  const tree = [
    cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
    cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: 'food' }),
    cat({ id: 'restaurants', name: 'Restaurants', bucket: 'Living', parent: 'food' }),
  ];

  it('rolls a parent up over its children and de-dups the total', () => {
    const s = makeState({
      categories: tree,
      breakdown: {
        groceries: spend({ posted: 80, pending: 0 }),   // 80
        restaurants: spend({ posted: 40, pending: 20 }), // 60
      },
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // Food has no direct spend but rolls up its children.
    expect(byId['food']).toMatchObject({ spent: 140, depth: 0, parentId: null, hasChildren: true });
    expect(byId['groceries']).toMatchObject({ spent: 80, depth: 1, parentId: 'food', hasChildren: false });
    expect(byId['restaurants']).toMatchObject({ spent: 60, depth: 1, parentId: 'food' });
    // The total counts each transaction ONCE — the parent, not parent + children.
    expect(total).toBe(140);
    // Depth-first: parent, then children by spend desc.
    expect(rows.map((r) => r.id)).toEqual(['food', 'groceries', 'restaurants']);
    // pct is a share of the grand total.
    expect(byId['groceries'].pct).toBeCloseTo((80 / 140) * 100, 5);
  });

  it('adds a "Directly in <parent>" row when a parent holds its own tagged spend', () => {
    // A txn filed straight onto the parent (Car) must not vanish when Car is expanded:
    // it shows as a synthetic child so the subtree reconciles to the parent bar.
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
      ],
      breakdown: {
        car: spend({ posted: 40, pending: 0 }),      // tagged directly to the parent
        parking: spend({ posted: 60, pending: 0 }),
      },
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['car']).toMatchObject({ spent: 100, hasChildren: true, depth: 0 });
    expect(byId['car__direct']).toMatchObject({ name: 'Directly in Car', spent: 40, parentId: 'car', depth: 1, hasChildren: false });
    // The two children (Parking 60 + Directly-in 40) reconcile to the parent's 100.
    expect(byId['parking'].spent + byId['car__direct'].spent).toBe(byId['car'].spent);
    expect(total).toBe(100);
  });

  it('rolls up a 3-level chain with correct depths, depth-first', () => {
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'daily', name: 'Daily', bucket: 'Living', parent: 'car' }),
        cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'daily' }),
      ],
      breakdown: { petrol: spend({ posted: 90, pending: 0 }) },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([['car', 0], ['daily', 1], ['petrol', 2]]);
    expect(rows[0].spent).toBe(90);  // Car rolls up the grandchild
    expect(total).toBe(90);
  });

  it('counts a cross-bucket child on its own and emits no phantom parent', () => {
    // A corrupt cross-bucket link (Odd is Lifestyle under a Living Car) must not nest;
    // Odd counts once at top level, and Car (no same-bucket spend) is NOT emitted.
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'odd', name: 'Odd', bucket: 'Lifestyle', parent: 'car' }),
      ],
      breakdown: { odd: spend({ posted: 30, pending: 0 }) },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => r.id)).toEqual(['odd']);       // no phantom Car row
    expect(rows[0]).toMatchObject({ depth: 0, parentId: null });
    expect(total).toBe(30);
  });

  it('terminates on a corrupt parent cycle and still emits the spending row', () => {
    const s = makeState({
      categories: [
        cat({ id: 'a', name: 'A', bucket: 'Living', parent: 'b' }),
        cat({ id: 'b', name: 'B', bucket: 'Living', parent: 'a' }),
      ],
      breakdown: { a: spend({ posted: 25, pending: 0 }) },
    });
    const { rows, total } = categoryBreakdown(s);  // must not hang
    expect(rows.some((r) => r.id === 'a')).toBe(true);
    expect(total).toBeGreaterThan(0);
  });
});
