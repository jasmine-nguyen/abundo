// WHIT-481 / WHIT-811 — the pure checkpoint-celebration diff, keyed by WHICH steps were reached.
// Locks: first look seeds silently, a known step newly reached bursts (once per goal, naming the
// highest), a step not in the last look never bursts, an unknown balance keeps the last look, a
// drop re-arms, and deleted steps/goals fall out.
import { describe, it, expect } from '@jest/globals';
import { diffCheckpointReached } from '../checkpointCelebration';
import { goalSteps, stepSnapshot } from './support/celebrationSteps';

describe('diffCheckpointReached', () => {
  it('seeds every goal on the first look and bursts nothing', () => {
    const { bursts, next } = diffCheckpointReached({}, [goalSteps('g1', [false]), goalSteps('g2', [true, true])]);
    expect(bursts).toEqual([]);
    expect(next).toEqual(stepSnapshot({ g1: [false], g2: [true, true] }));
  });

  it('bursts with the step label when a known step is newly reached, and is quiet on a redraw', () => {
    const prev = stepSnapshot({ g1: [true, false] });
    const crossed = diffCheckpointReached(prev, [goalSteps('g1', [true, true])]);
    expect(crossed.bursts).toEqual([{ goalId: 'g1', label: 'g1 step 1' }]);
    expect(crossed.next).toEqual(stepSnapshot({ g1: [true, true] }));

    expect(diffCheckpointReached(crossed.next, [goalSteps('g1', [true, true])]).bursts).toEqual([]);
  });

  it.each([
    ['a step added below the balance', { 'a@5000': false }, [['a@5000', false], ['c@3000', true]]],
    ['a step moved below the balance', { 'a@5000': false }, [['a@3000', true]]],
    ['a target lowered below the balance', { 'target@10000': false }, [['target@3000', true]]],
  ] as const)('never bursts for a step not in the last look: %s', (_, prevSteps, currentSteps) => {
    const steps = currentSteps.map(([key, reached]) => ({ key, reached, label: key }));
    expect(diffCheckpointReached({ g1: prevSteps }, [{ id: 'g1', steps }]).bursts).toEqual([]);
  });

  it('still bursts when a reached step is deleted and the next one is crossed', () => {
    const prev = { g1: { 'a@2000': true, 'b@5000': false } };
    const steps = [{ key: 'b@5000', reached: true, label: 'Hotel paid' }];
    expect(diffCheckpointReached(prev, [{ id: 'g1', steps }]).bursts).toEqual([{ goalId: 'g1', label: 'Hotel paid' }]);
  });

  it('bursts once per goal naming the highest step, in goal order, skipping goals seen for the first time', () => {
    const prev = stepSnapshot({ g1: [false, false, false], g2: [false] });
    const { bursts } = diffCheckpointReached(prev, [
      goalSteps('g1', [true, true, false]),
      goalSteps('g2', [true]),
      goalSteps('g3', [true]),
    ]);
    expect(bursts).toEqual([
      { goalId: 'g1', label: 'g1 step 1' },
      { goalId: 'g2', label: 'g2 step 0' },
    ]);
  });

  it('keeps the last look through an unknown balance, and never seeds an unseen goal from one', () => {
    const prev = stepSnapshot({ g1: [false] });
    const gone = diffCheckpointReached(prev, [goalSteps('g1', null), goalSteps('g2', null)]);
    expect(gone.bursts).toEqual([]);
    expect(gone.next).toEqual(prev);

    const back = diffCheckpointReached(gone.next, [goalSteps('g1', [true])]);
    expect(back.bursts).toEqual([{ goalId: 'g1', label: 'g1 step 0' }]);
  });

  it('re-arms after a drop: a step that fell back bursts again when re-crossed', () => {
    const dropped = diffCheckpointReached(stepSnapshot({ g1: [true] }), [goalSteps('g1', [false])]);
    expect(dropped.bursts).toEqual([]);
    const recrossed = diffCheckpointReached(dropped.next, [goalSteps('g1', [true])]);
    expect(recrossed.bursts).toEqual([{ goalId: 'g1', label: 'g1 step 0' }]);
  });

  it('drops a deleted goal; a re-added same id re-seeds without a burst', () => {
    const afterDelete = diffCheckpointReached(stepSnapshot({ g1: [true], g2: [false] }), [goalSteps('g1', [true])]);
    expect(afterDelete.next).toEqual(stepSnapshot({ g1: [true] }));
    expect(diffCheckpointReached(afterDelete.next, [goalSteps('g1', [true]), goalSteps('g2', [true])]).bursts).toEqual([]);
  });
});
