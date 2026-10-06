// WHIT-776 QA — one SAVED_MILESTONES object now feeds every milestone suite (in milestone.logic it
// is both VALID and the saved read-path plan). If the code it is handed ever rewrote it in place,
// the next test reading the "same" plan would quietly see different rows. Lock that it doesn't.
import { describe, it, expect } from '@jest/globals';
import { milestoneView } from '../context';
import { milestonesOrderingError, milestoneOutOfOrderRows } from '../milestones';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { makeState } from './factory';

describe('the shared milestone plan is never changed by the code it feeds', () => {
  // [A1]
  it('the ordering checks and the progress view leave SAVED_MILESTONES exactly as it was', () => {
    const before = JSON.parse(JSON.stringify(SAVED_MILESTONES));

    expect(milestonesOrderingError(SAVED_MILESTONES)).toBeNull();
    milestoneOutOfOrderRows(SAVED_MILESTONES);
    const view = milestoneView(makeState({ milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: null } }));
    view.rows.forEach((row) => Object.assign(row, { label: 'changed by a consumer' }));

    expect(SAVED_MILESTONES).toEqual(before);
  });
});
