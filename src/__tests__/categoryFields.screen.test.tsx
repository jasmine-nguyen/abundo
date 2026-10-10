// WHIT-239 — CategoryFields, the ONE shared implementation of the category field controls
// (name / bucket / parent / icon), consumed by both QuickCreateCategory (compact) and the
// category-edit screen (screen). It is pure-presentational, so it renders with no mocks.
// The full-parent greying lives with the edit screen (categoryEditSummaryToast).
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CategoryFields } from '../components/CategoryFields';
import { ICON_KEYS } from '../icons';

// [G1] Every icon in the grid is wired to onIconChange(thatKey), and every ICON_KEYS icon
// renders. WHIT-247: each cell carries an `icon-<key>` testID, so we tap it directly instead of
// walking the render tree. Fail-on-revert: mis-wire the grid (onIconChange(icon) instead of
// onIconChange(k), or drop the handler) → red.
it('the icon grid reports the tapped icon key via onIconChange', () => {
  const onIconChange = jest.fn();
  render(
    <CategoryFields
      variant="compact"
      name=""
      namePlaceholder="e.g. Coffee runs"
      bucket="Living"
      icon="coffee"
      parent={null}
      categories={[]}
      editId={null}
      noneLabel="None (top-level)"
      lockBucket
      parentPicker={false}
      onNameChange={jest.fn()}
      onBucketChange={jest.fn()}
      onIconChange={onIconChange}
      onParentChange={jest.fn()}
    />,
  );
  expect(screen.getAllByTestId(/^icon-/)).toHaveLength(ICON_KEYS.length);   // every icon renders
  fireEvent.press(screen.getByTestId('icon-car'));
  expect(onIconChange).toHaveBeenCalledWith('car');
  expect(onIconChange).toHaveBeenCalledTimes(1);
});
