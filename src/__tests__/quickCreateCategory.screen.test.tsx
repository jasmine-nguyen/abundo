// WHIT-237/238 — QuickCreateCategory, the shared inline "make a category" mini-form. Uses only
// pure exports (BUCKETS / eligibleParents), so we render it against the REAL context module —
// no mock — and assert its presentational contract. Gap: the implementer's suites drive it only
// through the two host screens; its own prop matrix (lockBucket, parentPicker, busy, the
// bucket-change parent-drop effect) is otherwise unlocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QuickCreateCategory } from '../components/QuickCreateCategory';
import { cat } from './factory';

const onSubmit = jest.fn();
const onCancel = jest.fn();
beforeEach(() => { onSubmit.mockClear(); onCancel.mockClear(); });

// [A5] lockBucket hides the bucket picker (a new sub inherits its parent's bucket).
it('lockBucket hides the bucket chips', () => {
  render(<QuickCreateCategory initialBucket="Living" lockBucket submitLabel="Add sub-category" onSubmit={onSubmit} />);
  // With the picker hidden, none of the other bucket labels render.
  expect(screen.queryByText('Income')).toBeNull();
  expect(screen.queryByText('Savings')).toBeNull();
  expect(screen.queryByText('Lifestyle')).toBeNull();
});

// [A6] parentPicker: the picked parent is stamped onto the draft handed to onSubmit.
it('parentPicker carries the picked parent id on the draft', () => {
  const cats = [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null })];
  render(<QuickCreateCategory initialBucket="Living" parentPicker categories={cats} submitLabel="Create & file" onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Parking');
  fireEvent.press(screen.getByText('Car'));            // pick the same-bucket parent
  fireEvent.press(screen.getByText('Create & file'));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Parking', bucket: 'Living', parent: 'car' }));
});

// [A7] Changing bucket under a picked parent drops the now cross-bucket parent to top-level,
// so a category can never be saved under a parent from a different bucket. Fail-on-revert: kill
// the drop effect and this submits parent:'car' with bucket:'Lifestyle'.
it('changing bucket drops a now-ineligible picked parent to null', () => {
  const cats = [
    cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
    cat({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', parent: null }),
  ];
  render(<QuickCreateCategory initialBucket="Living" parentPicker categories={cats} submitLabel="Create & file" onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Parking');
  fireEvent.press(screen.getByText('Car'));            // parent = Living 'car'
  fireEvent.press(screen.getByText('Lifestyle'));      // switch bucket → car is now cross-bucket
  fireEvent.press(screen.getByText('Create & file'));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'Lifestyle', parent: null }));
});

// [A8] busy=true guards the submit button (the sheet's double-tap guard while a create is in
// flight). Fail-on-revert: drop `!busy` from canSave and onSubmit fires despite busy.
it('busy blocks submit (double-submit guard)', () => {
  render(<QuickCreateCategory initialBucket="Lifestyle" busy submitLabel="Create & file" onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
  fireEvent.press(screen.getByText('Create & file'));
  expect(onSubmit).not.toHaveBeenCalled();
});

// [A9] WHIT-283: the draft persistence is OPT-IN. With no readDraft/writeDraft (the category-edit
// host), the form initialises empty and typing runs the persist effect as a no-op — no throw,
// even with NO AppProvider (this whole suite renders without one). Locks the shared-component
// no-regression contract: category-edit is unchanged.
it('no draft props: form starts empty and typing does not throw (opt-in, no context coupling)', () => {
  render(<QuickCreateCategory initialBucket="Lifestyle" submitLabel="Add sub-category" onSubmit={onSubmit} />);
  const input = screen.getByPlaceholderText('Category name');
  expect(input.props.value).toBe('');                     // draft not consulted → empty default
  fireEvent.changeText(input, 'Gym');                     // persist effect fires with writeDraft undefined → no-op
  fireEvent.press(screen.getByText('Add sub-category'));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym' }));
});
