// WHIT-481 — the ref-held "last shown" hook that drives the confetti. The 12 logic tests lock the
// pure diff; these lock what only the HOOK adds on top of it: which goal the burst is LABELLED off
// when several tick up, that the label reads the goal NAME (not id), that a brand-new goal seen for
// the first time never labels, that a new counts-array IDENTITY with unchanged reached counts does
// NOT re-burst (the effect re-runs but must stay quiet), and that celebrationKey only ever advances
// on a genuine tick-up. Uses the real hook + real diff; only React drives it via renderHook.
import { describe, it, expect } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { useCheckpointCelebration, CheckpointCount } from '../hooks/useCheckpointCelebration';

// Build a fresh counts ARRAY each call so identity always differs — the caller memoises, but the
// hook must not lean on identity for correctness, only for skipping the effect.
const counts = (...cs: CheckpointCount[]): CheckpointCount[] => cs.map((c) => ({ ...c }));

describe('useCheckpointCelebration (WHIT-481 hook layer)', () => {
  it('seeds on first render and never bursts (key stays 0, no label)', () => {
    // [A-H1] first effect run seeds every goal, bursts nothing — even a goal already past a rung.
    const { result } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: { c: counts({ id: 'g1', name: 'Holiday', reached: 2 }) },
    });
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('labels the burst off the goal NAME, not its id', () => {
    // [A-H2] a tick-up sets label to the human name — a test that would pass on id must be ruled out.
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: { c: counts({ id: 'g1', name: 'New car fund', reached: 1 }) },
    });
    rerender({ c: counts({ id: 'g1', name: 'New car fund', reached: 2 }) });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('New car fund');
    expect(result.current.newlyReached).toBe(1);
  });

  it('labels off the FIRST bursting goal in array order when several tick up together', () => {
    // [A-H3] g1 and g2 both cross in one refresh → one burst, labelled off g1 (bursts[0]).
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: {
        c: counts({ id: 'g1', name: 'Emergency', reached: 0 }, { id: 'g2', name: 'Wedding', reached: 1 }),
      },
    });
    rerender({
      c: counts({ id: 'g1', name: 'Emergency', reached: 1 }, { id: 'g2', name: 'Wedding', reached: 2 }),
    });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Emergency');
  });

  it('labels off the goal that actually ticked, not the first goal in the array', () => {
    // [A-H4] g1 unchanged, only g2 ticks up → label must be g2 (bursts skips the un-ticked g1).
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: {
        c: counts({ id: 'g1', name: 'Emergency', reached: 3 }, { id: 'g2', name: 'Wedding', reached: 1 }),
      },
    });
    rerender({
      c: counts({ id: 'g1', name: 'Emergency', reached: 3 }, { id: 'g2', name: 'Wedding', reached: 2 }),
    });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Wedding');
  });

  it('does NOT re-burst when the counts array is a new identity but every reached count is unchanged', () => {
    // [A-H5] the caller's memo yields a fresh array on any goals-identity churn; the effect re-runs
    // but the diff finds no tick-up, so the key must stay put. This is the "plain redraw, new array"
    // guard the identical-reference screen test can't reach.
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: { c: counts({ id: 'g1', name: 'Holiday', reached: 1 }) },
    });
    rerender({ c: counts({ id: 'g1', name: 'Holiday', reached: 1 }) }); // new array, same count
    rerender({ c: counts({ id: 'g1', name: 'Holiday', reached: 1 }) }); // and again
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('does not label off a brand-new goal seen for the first time even as another ticks up', () => {
    // [A-H6] g1 ticks up (labelled), g2 appears for the first time already past rungs → seeded, must
    // not steal the label nor add a burst.
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: { c: counts({ id: 'g1', name: 'Holiday', reached: 1 }) },
    });
    rerender({
      c: counts({ id: 'g1', name: 'Holiday', reached: 2 }, { id: 'g2', name: 'Fresh', reached: 5 }),
    });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Holiday');
    expect(result.current.newlyReached).toBe(1);
  });

  it('advances the key once per genuine tick-up across successive refreshes', () => {
    // [A-H7] two separate crossings → key 1 then 2 (rapid re-bursts each re-fire the overlay).
    const { result, rerender } = renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c), {
      initialProps: { c: counts({ id: 'g1', name: 'Holiday', reached: 0 }) },
    });
    rerender({ c: counts({ id: 'g1', name: 'Holiday', reached: 1 }) });
    expect(result.current.celebrationKey).toBe(1);
    rerender({ c: counts({ id: 'g1', name: 'Holiday', reached: 2 }) });
    expect(result.current.celebrationKey).toBe(2);
    expect(result.current.newlyReached).toBe(1);
  });
});
