// SpendingDonut fade/dim behaviour with reduce-motion ON (the springs settle synchronously via
// setValue, so no clock to advance). Merged from the DimEdges/Fold/Reenter/Selection donut suites
// (WHIT-451) — every one mocked useReduceMotion → true, so they share this one file-level mock. The
// reduce-motion-OFF (animated) branch stays in spendingDonutDimMotion.screen.test.tsx.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, WEDGE_DIM_FALLBACK, activeSelection, type DonutSlice } from '../components/SpendingDonut';
import { OTHER_COLOR } from '../chartColors';
import { wedgeDimOpacity } from '../contrast';
import { opacityOf, ancestorProp, sl, DIM_BLUE, DIM_GREEN, DIM_OTHER } from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });

const TWO: DonutSlice[] = [
  { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
  { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
];
const ONLY_G: DonutSlice[] = [{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }];

describe('SpendingDonut — the fade maths assumes each wedge is painted EXACTLY once', () => {
  // [A56] The whole derivation rests on "a faded wedge sits on the opaque CHART_BG track below and
  // nothing else" (SpendingDonut.tsx:93-95). Two stacked copies at opacity a composite to
  // 1-(1-a)^2 -- 0.561 would land at 0.807 -- so the measured contrast would silently stop being
  // the contrast the module computed. The overlay must therefore never carry a second painted band,
  // and must only ever exist for the wedge whose opacity is 1.
  // FAIL-ON-REVERT: drop the `interactive ?` guard on bandTestID (SpendingDonut.tsx:267) and the
  // band count goes to 4.
  it('[A56] a dimmed wedge has exactly one painted band; the overlay adds none and sits at 1', () => {
    render(<SpendingDonut slices={[sl('a', 50), sl('b', 30), sl('c', 20)]} />);
    expect(screen.getAllByTestId(/^donut-band-/)).toHaveLength(3);

    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(screen.getAllByTestId(/^donut-band-/)).toHaveLength(3);   // still one band per wedge
    expect(screen.getByTestId('donut-top')).toBeTruthy();            // the overlay IS drawn
    expect(ancestorProp('donut-top', 'opacity')).toBeCloseTo(1);     // ...only ever at full opacity
    expect(ancestorProp('donut-band-a', 'opacity')).toBeCloseTo(1);  // as is the base under it
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);                    // the faded ones are single-painted
    expect(opacityOf('c')).toBeCloseTo(DIM_BLUE);
  });

});

describe('SpendingDonut — the fade must track the CURRENT colour, not a remembered one', () => {
  // [A58] `anims` is keyed by id and never evicted (SpendingDonut.tsx:171). The fade, unlike the
  // emphasis value, is a function of the COLOUR — and a category's colour really does change under
  // a stable id: chartColors.ts:84-88 documents a client running ahead of the server falling back
  // to an id-derived hue, then switching to the slotted one once `colorSlot` arrives.
  // This is also the tripwire for the obvious performance fix: wedgeDimOpacity runs a 30-step
  // bisection per wedge per redraw, and caching it BY ID (rather than by colour) would pass every
  // other test in the suite and pin the old hue's fade forever.
  it('[A58] a wedge recoloured while it is dimmed re-derives its fade', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);   // b is #7aa2f7

    // Same id, same value, new colour — only the hue moved.
    rerender(<SpendingDonut slices={[sl('a', 75), slice('b', '#7FD49B', 25)]} />);

    expect(screen.getByTestId('donut-band-b').props.stroke).toBe('#7FD49B');
    expect(opacityOf('b')).toBeCloseTo(DIM_GREEN);  // the greener, brighter hue fades FURTHER
    expect(DIM_GREEN).toBeLessThan(DIM_BLUE);       // ...which is the point of deriving it at all
    expect(opacityOf('a')).toBeCloseTo(1);
  });

  // [A59] An unusable colour string reaching the REAL component, not just the pure module. [Q33]
  // proves wedgeDimOpacity returns null; nothing proved the render substitutes the fallback and that
  // it survives the interpolation — and the fallback is the one path where a dimmed wedge is nearly
  // indistinguishable from the picked one (0.85 vs 1). Empty string is the realistic shape — a
  // category row whose colour never resolved.
  it('[A59] a wedge with an unparseable colour still renders, and lands on the fallback', () => {
    render(<SpendingDonut slices={[sl('a', 60), slice('broken', '', 40)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(opacityOf('broken')).toBeCloseTo(WEDGE_DIM_FALLBACK);
    expect(opacityOf('broken')).toBeLessThan(1);          // it does step back, per WEDGE_DIM_FALLBACK
    expect(opacityOf('broken')).toBeGreaterThan(DIM_BLUE); // ...but far less than a measurable peer:
                                                           // an unresolved colour reads closest to
                                                           // "selected" of anything on the ring.
    expect(wedgeDimOpacity('')).toBeNull();               // the module half: it measures nothing here
  });
});

describe('SpendingDonut — repeated selection lands exactly on the derived values', () => {
  // [A60] Select -> deselect -> select a DIFFERENT wedge, with three different colours in play. The
  // fade is now three different numbers instead of one shared constant, so a wedge picking up a
  // neighbour's floor (a mixed-up index, a shared interpolation, a memo keyed on the wrong thing)
  // is a NEW class of bug that the old flat DIM could not express. Nothing else drives the cycle
  // more than once.
  it('[A60] each wedge returns to its OWN floor on every re-selection, never a neighbour\'s', () => {
    render(<SpendingDonut slices={[
      slice('blue', '#7aa2f7', 50), slice('green', '#7FD49B', 30), slice('grey', OTHER_COLOR, 20),
    ]} />);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));
    expect(opacityOf('green')).toBeCloseTo(DIM_GREEN);
    expect(opacityOf('grey')).toBeCloseTo(DIM_OTHER);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));   // tap again -> deselect
    for (const id of ['blue', 'green', 'grey']) expect(opacityOf(id)).toBeCloseTo(1);

    fireEvent.press(screen.getByTestId('donut-slice-green'));  // now pick a different one
    expect(opacityOf('green')).toBeCloseTo(1);
    expect(opacityOf('blue')).toBeCloseTo(DIM_BLUE);           // its own floor, not green's
    expect(opacityOf('grey')).toBeCloseTo(DIM_OTHER);

    fireEvent.press(screen.getByTestId('donut-center-reset')); // clear from the hole
    for (const id of ['blue', 'green', 'grey']) expect(opacityOf(id)).toBeCloseTo(1);

    fireEvent.press(screen.getByTestId('donut-slice-grey'));   // and once more, third wedge
    expect(opacityOf('grey')).toBeCloseTo(1);
    expect(opacityOf('blue')).toBeCloseTo(DIM_BLUE);
    expect(opacityOf('green')).toBeCloseTo(DIM_GREEN);
  });
});

describe('SpendingDonut — selected tail slice folds into __other__ (gap)', () => {
  // [A5] Tapped 'coffee' is individually painted, then a data change pushes it into the tail so it
  // folds into '__other__' — its id LEAVES painted. activeId flips to null → ring un-dims. 'a'
  // existed before, was dimmed, and survives; it must return to 1.
  // FAIL-ON-REVERT: with selectedId (not activeId) in the effect deps/target, the effect never
  // re-runs on this data change (selectedId is still 'coffee'), so 'a' stays stuck dimmed.
  it('[A5] folding the selected slice into __other__ un-dims the ring (coffee → __other__)', () => {
    const before: DonutSlice[] = [
      sl('a', 100), sl('b', 60), sl('c', 50), { id: 'coffee', name: 'Coffee', color: '#E8A87C', value: 40 }, sl('e', 20),
    ]; // 5 painted, coffee individual
    const { rerender } = render(<SpendingDonut slices={before} />);

    fireEvent.press(screen.getByTestId('donut-slice-coffee'));
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE); // a dims while Coffee is popped

    const after: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50),
      { id: 'coffee', name: 'Coffee', color: '#E8A87C', value: 1 }, // now smallest → tail → __other__
    ]; // 7 positive, cap 6 → top5 a,b,c,d,e + (f,coffee) folded into __other__
    rerender(<SpendingDonut slices={after} />);

    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy(); // fold happened
    expect(screen.queryByTestId('donut-slice-coffee')).toBeNull();    // coffee no longer painted
    expect(opacityOf('a')).toBeCloseTo(1);                            // ring un-dimmed, NOT stuck
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$451'); // hole back to the total (nothing popped)
  });
});

describe('SpendingDonut — selecting __other__ then its composition changes (gap)', () => {
  // [A6] '__other__' persists across the change, so the (deliberately unreset) selection is kept:
  // Other stays popped, siblings stay dimmed, and the hole total re-reads the new Other sum.
  // CHARACTERIZATION: buggy and fixed code behave identically here (id persists), so this does NOT
  // fail on revert — it guards that the fix did not accidentally drop a still-valid selection.
  it('[A6] Other stays popped and the hole total updates when its members change', () => {
    const seven: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 30), sl('g', 20),
    ]; // __other__ = f+g = 50
    const { rerender } = render(<SpendingDonut slices={seven} />);

    fireEvent.press(screen.getByTestId('donut-slice-__other__'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$50');
    expect(opacityOf('__other__')).toBeCloseTo(1);   // Other popped
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE);        // siblings dimmed

    const seven2: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 30), sl('g', 45),
    ]; // tail still f+g, now = 75
    rerender(<SpendingDonut slices={seven2} />);

    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$75'); // hole re-reads Other sum
    expect(opacityOf('__other__')).toBeCloseTo(1);   // still popped (selection preserved)
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE);        // siblings still dimmed
  });
});

describe('SpendingDonut — data change that spares the selection (gap)', () => {
  // [A7] Only a NON-selected slice changes; the selected 'c' remains painted → selection + dimming
  // must be untouched. REGRESSION GUARD against an over-eager reset (e.g. if activeSelection ever
  // nulled on any data change). Does not fail on reverting THIS fix (both keep it popped).
  it('[A7] changing a non-selected slice does not disturb the popped/dimmed state', () => {
    const three: DonutSlice[] = [
      { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
      { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
      sl('x', 40),
    ];
    const { rerender } = render(<SpendingDonut slices={three} />);

    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(opacityOf('c')).toBeCloseTo(1);    // Coffee popped
    expect(opacityOf('g')).toBeCloseTo(DIM_GREEN); // Groceries dimmed

    rerender(
      <SpendingDonut slices={[
        { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
        { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
        sl('x', 99), // only x changes
      ]} />,
    );

    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25'); // still Coffee
    expect(opacityOf('c')).toBeCloseTo(1);    // still popped
    expect(opacityOf('g')).toBeCloseTo(DIM_GREEN); // still dimmed
  });
});

describe('SpendingDonut — a cached wedge re-entering must re-target, not keep its stale emphasis', () => {
  // [A8] A wedge that was itself POPPED (+1), left the data, then RETURNS while a DIFFERENT category
  // is selected. Its Animated.Value is cached at +1 (map never evicts). It must dim to −1 to
  // match its peers, NOT paint popped/bright as if it were still the selection.
  // FAIL-ON-REVERT (paintedKey dep): on return activeId is unchanged ('a'), so with deps
  // [activeId, reduceMotion] the effect does not re-run and emphasisOf('z') hands back the stale +1
  // → opacity 1. With paintedKey in the deps the effect re-targets z to −1 → dimmed. Distinct from
  // E2, whose stale value is 0 (rest) — here it is +1 (popped), a wedge masquerading as selected.
  it('[A8] a previously-popped wedge returning while another is selected dims (not stuck popped)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);

    fireEvent.press(screen.getByTestId('donut-slice-z')); // pop z → its cached value is +1
    expect(opacityOf('z')).toBeCloseTo(1);
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves; +1 stays cached
    fireEvent.press(screen.getByTestId('donut-slice-a'));            // now select a instead
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, a held

    expect(opacityOf('z')).toBeCloseTo(DIM_BLUE); // re-targeted to dim, NOT the stale popped +1
    expect(opacityOf('a')).toBeCloseTo(1);    // a is the live selection
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);
  });

  // [A9] The over-dim guard the fix must not trip: a wedge cached DIMMED (−1) that returns while
  // NOTHING is selected must go full-bright (rest), not stay stuck dimmed. E3 only covers a
  // first-seen wedge (born at its target); this covers a CACHED one whose stale value is −1.
  // FAIL-ON-REVERT (paintedKey dep): activeId is null both before and after the return, so without
  // the dep the effect never re-runs and z keeps its cached −1 → wrongly dimmed.
  // With the dep it re-targets to 0 → opacity 1.
  it('[A9] a previously-dimmed wedge returning while nothing is selected goes full-bright (no over-dim)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);

    fireEvent.press(screen.getByTestId('donut-slice-a')); // z dims to −1, cached
    expect(opacityOf('z')).toBeCloseTo(DIM_BLUE);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves; −1 stays cached
    fireEvent.press(screen.getByTestId('donut-slice-a'));            // deselect a → nothing selected
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, no selection

    expect(opacityOf('z')).toBeCloseTo(1); // back to rest, NOT stuck dimmed
    expect(opacityOf('a')).toBeCloseTo(1);
    expect(opacityOf('b')).toBeCloseTo(1);
  });

  // [A10] The synthesised '__other__' bucket appearing for the first time (tail crosses 6 → 7) while
  // a selection is held must paint dimmed like the real peers — at ITS OWN floor, which is far
  // higher than theirs because the grey starts darker. That difference is the point: a bucket born
  // at a peer's fade instead of its own would be invisible, which is the WHIT-425 bug.
  // CHARACTERIZATION w.r.t. the paintedKey dep: __other__ is FIRST-SEEN here, so emphasisOf inits it
  // at its target (−1) and reverting the dep ALONE still leaves it dimmed — this does NOT fail on
  // that revert (it fails only if the init is ALSO reverted, exactly like E1). Its value is a
  // data-path guard: the fold-created bucket is covered by the same emphasis wiring as a real id.
  it('[A10] the __other__ bucket newly appearing while one is selected paints dimmed at its own floor', () => {
    const six: DonutSlice[] = [sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50)];
    const { rerender } = render(<SpendingDonut slices={six} />); // 6 painted, no __other__
    expect(screen.queryByTestId('donut-slice-__other__')).toBeNull();

    fireEvent.press(screen.getByTestId('donut-slice-a')); // select a → peers dim
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);

    const seven: DonutSlice[] = [...six, sl('g', 10)]; // 7 positive → f,g fold into __other__
    rerender(<SpendingDonut slices={seven} />);

    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy();
    expect(opacityOf('__other__')).toBeCloseTo(DIM_OTHER); // its own floor, not a peer's
    expect(opacityOf('__other__')).toBeGreaterThan(DIM_BLUE); // the grey needs far more opacity
    expect(opacityOf('a')).toBeCloseTo(1);                 // a still popped
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);          // untouched peer still dimmed
  });
});

describe('activeSelection (pure)', () => {
  it('keeps the id while its category is still painted', () => {
    expect(activeSelection('c', TWO)).toBe('c');
  });
  it('drops to null when the id is no longer painted', () => {
    expect(activeSelection('c', ONLY_G)).toBeNull();
  });
  it('is null when nothing is selected', () => {
    expect(activeSelection(null, TWO)).toBeNull();
  });
});

describe('SpendingDonut — selection clears when its category leaves the data', () => {
  // Fail-on-revert anchor for the real fix (activeId in the spring target + effect deps): with the
  // bug, the effect never re-runs when the data changes, so Groceries stays dimmed.
  it('un-dims the ring when the selected category drops out (no stuck all-dimmed ring)', () => {
    const { rerender } = render(<SpendingDonut slices={TWO} />);

    fireEvent.press(screen.getByTestId('donut-slice-c')); // select Coffee → Groceries dims
    expect(opacityOf('g')).toBeCloseTo(DIM_GREEN);

    rerender(<SpendingDonut slices={ONLY_G} />); // Coffee leaves the data
    expect(opacityOf('g')).toBeCloseTo(1); // un-dimmed, not stuck
  });
});

describe('SpendingDonut — the fold bucket fades on its own floor (WHIT-425)', () => {
  // The grey "Other" needs far more opacity than a category to reach the same visibility, because
  // it starts far darker. [A10] covers the bucket APPEARING mid-selection; this covers the ordinary
  // case — it is already on screen when you tap a category.
  // FAIL-ON-REVERT: give every wedge one shared fade and Other lands at a category's 0.561, where
  // it measures 1.9:1 and is the wedge WHIT-425 was filed about.
  it('a category selection dims the real peers and the bucket, each to its own value', () => {
    const seven: DonutSlice[] = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`, name: `s${i}`, color: '#7aa2f7', value: 100 - i * 10,
    })); // 7 positive, cap 6 → the tail folds into __other__
    render(<SpendingDonut slices={seven} />);
    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy();

    fireEvent.press(screen.getByTestId('donut-slice-s0'));
    expect(opacityOf('s0')).toBeCloseTo(1);                      // the picked wedge leads
    expect(opacityOf('s1')).toBeCloseTo(DIM_BLUE);               // a real peer steps back
    expect(opacityOf('__other__')).toBeCloseTo(DIM_OTHER);       // so does the bucket, further up
    expect(opacityOf('__other__')).toBeLessThan(1);              // it really does fade
  });
});

