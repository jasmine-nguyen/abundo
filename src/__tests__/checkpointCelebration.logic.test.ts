// WHIT-481 — the pure checkpoint-celebration diff. Locks every "don't burst when we shouldn't"
// guard: hydrate/first-load seeds silently, a genuine tick-up bursts, unchanged/plain-redraw is
// quiet, a null (unknown balance) never seeds but keeps a prior count so a later higher balance
// still bursts, a drop re-arms, and a deleted goal falls out.
import { describe, it, expect } from '@jest/globals';
import { diffCheckpointReached, ReachedSnapshot } from '../checkpointCelebration';

describe('diffCheckpointReached', () => {
  it('seeds every goal on the first diff and bursts nothing (hydrate guard)', () => {
    const current = [
      { id: 'g1', reached: 0 },
      { id: 'g2', reached: 2 }, // already past two rungs when the screen opens
    ];
    const { bursts, next } = diffCheckpointReached({}, current);
    expect(bursts).toEqual([]);
    expect(next).toEqual({ g1: 0, g2: 2 });
  });

  it('bursts when a count ticks up by one', () => {
    const { bursts, next } = diffCheckpointReached({ g1: 1 }, [{ id: 'g1', reached: 2 }]);
    expect(bursts).toEqual([{ goalId: 'g1', newlyReached: 1 }]);
    expect(next).toEqual({ g1: 2 });
  });

  it('bursts once with the full jump when several rungs cross at once', () => {
    const { bursts } = diffCheckpointReached({ g1: 0 }, [{ id: 'g1', reached: 3 }]);
    expect(bursts).toEqual([{ goalId: 'g1', newlyReached: 3 }]);
  });

  it('is quiet when the count is unchanged (a plain redraw)', () => {
    const { bursts, next } = diffCheckpointReached({ g1: 2 }, [{ id: 'g1', reached: 2 }]);
    expect(bursts).toEqual([]);
    expect(next).toEqual({ g1: 2 });
  });

  it('never seeds and never bursts a goal whose balance is unknown', () => {
    const { bursts, next } = diffCheckpointReached({}, [{ id: 'g1', reached: null }]);
    expect(bursts).toEqual([]);
    expect(next).toEqual({}); // stays unseen
  });

  it('seeds silently (no burst) the first time an unknown goal resolves to a number', () => {
    // Tick 1: unknown → unseen. Tick 2: resolves to 2 (already past rungs) → seed, no burst.
    const first = diffCheckpointReached({}, [{ id: 'g1', reached: null }]);
    const second = diffCheckpointReached(first.next, [{ id: 'g1', reached: 2 }]);
    expect(second.bursts).toEqual([]);
    expect(second.next).toEqual({ g1: 2 });
  });

  it('keeps a prior count through an unknown tick so a later higher balance still bursts', () => {
    // seeded at 3 → balance goes unknown → returns at 5: must burst newlyReached 2.
    const seeded = { g1: 3 };
    const gone = diffCheckpointReached(seeded, [{ id: 'g1', reached: null }]);
    expect(gone.bursts).toEqual([]);
    expect(gone.next).toEqual({ g1: 3 }); // carried forward, not dropped
    const back = diffCheckpointReached(gone.next, [{ id: 'g1', reached: 5 }]);
    expect(back.bursts).toEqual([{ goalId: 'g1', newlyReached: 2 }]);
  });

  it('does not burst when an unknown tick returns at the same count', () => {
    const gone = diffCheckpointReached({ g1: 3 }, [{ id: 'g1', reached: null }]);
    const back = diffCheckpointReached(gone.next, [{ id: 'g1', reached: 3 }]);
    expect(back.bursts).toEqual([]);
  });

  it('re-arms after a drop: a count that fell below a rung bursts again when re-crossed', () => {
    const dropped = diffCheckpointReached({ g1: 2 }, [{ id: 'g1', reached: 1 }]); // fell back
    expect(dropped.bursts).toEqual([]);
    expect(dropped.next).toEqual({ g1: 1 });
    const recrossed = diffCheckpointReached(dropped.next, [{ id: 'g1', reached: 2 }]);
    expect(recrossed.bursts).toEqual([{ goalId: 'g1', newlyReached: 1 }]);
  });

  it('bursts once off the ticked-up goal even when another goal is seen for the first time', () => {
    // g1 seeded and ticking up; g2 brand-new in the same refresh → one burst, off g1 only.
    const { bursts, next } = diffCheckpointReached({ g1: 1 }, [
      { id: 'g1', reached: 2 },
      { id: 'g2', reached: 3 }, // never seen → seed silently
    ]);
    expect(bursts).toEqual([{ goalId: 'g1', newlyReached: 1 }]);
    expect(next).toEqual({ g1: 2, g2: 3 });
  });

  it('reports a burst per goal when two goals genuinely tick up together', () => {
    const { bursts } = diffCheckpointReached({ g1: 0, g2: 1 }, [
      { id: 'g1', reached: 1 },
      { id: 'g2', reached: 2 },
    ]);
    expect(bursts).toEqual([
      { goalId: 'g1', newlyReached: 1 },
      { goalId: 'g2', newlyReached: 1 },
    ]);
  });

  it('drops a deleted goal from the snapshot; a re-added same id re-seeds without a burst', () => {
    const afterDelete = diffCheckpointReached({ g1: 2, g2: 1 }, [{ id: 'g1', reached: 2 }]);
    expect(afterDelete.next).toEqual({ g1: 2 }); // g2 fell out
    const readded = diffCheckpointReached(afterDelete.next, [
      { id: 'g1', reached: 2 },
      { id: 'g2', reached: 4 }, // same id back, already past rungs → seed, no burst
    ]);
    expect(readded.bursts).toEqual([]);
    expect(readded.next).toEqual({ g1: 2, g2: 4 });
  });
});
