// WHIT-239 GAP — the two wiring details the implementer's categoryFields.screen.test.tsx never
// taps: (1) the ICON grid's onIconChange (its 9 tests exercise name/bucket/parent but never an
// icon), and (2) the per-surface autoFocus difference (compact focuses the name so you can type
// straight away; the full screen must NOT, or opening it would yank the keyboard up over the
// preview). Both are pure props on the shared CategoryFields, rendered against the REAL context
// module (no mock) exactly like the implementer's suite.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CategoryFields } from '../components/CategoryFields';
import { ICON_KEYS } from '../icons';
import { Bucket } from '../context';

const handlers = {
  onNameChange: jest.fn(),
  onBucketChange: jest.fn(),
  onIconChange: jest.fn(),
  onParentChange: jest.fn(),
};
beforeEach(() => { Object.values(handlers).forEach((h) => h.mockClear()); });

function renderFields(over: Partial<React.ComponentProps<typeof CategoryFields>> = {}) {
  return render(
    <CategoryFields
      variant="screen"
      name=""
      namePlaceholder="e.g. Coffee runs"
      bucket={(over.bucket ?? 'Living') as Bucket}
      icon={over.icon ?? 'coffee'}
      parent={over.parent ?? null}
      categories={over.categories ?? []}
      editId={over.editId ?? null}
      noneLabel={over.noneLabel ?? 'None (top-level)'}
      onNameChange={handlers.onNameChange}
      onBucketChange={handlers.onBucketChange}
      onIconChange={handlers.onIconChange}
      onParentChange={handlers.onParentChange}
      {...over}
    />,
  );
}

// [G1] Every icon in the grid is wired to onIconChange(thatKey), and every ICON_KEYS icon
// renders. WHIT-247: each cell carries an `icon-<key>` testID, so we tap it directly instead of
// walking the render tree — no structural coupling to "the icon grid is the only Pressable here".
// The all-render check stays (keyed on the testID prefix, not the tree shape). Fail-on-revert:
// mis-wire the grid (onIconChange(icon) instead of onIconChange(k), or drop the handler) → red.
it('the icon grid reports the tapped icon key via onIconChange', () => {
  renderFields({ variant: 'compact', lockBucket: true, parentPicker: false });
  expect(screen.getAllByTestId(/^icon-/)).toHaveLength(ICON_KEYS.length);   // every icon renders
  fireEvent.press(screen.getByTestId('icon-car'));
  expect(handlers.onIconChange).toHaveBeenCalledWith('car');
  expect(handlers.onIconChange).toHaveBeenCalledTimes(1);
});

// [G2] The compact form (categorise sheet / inline sub) auto-focuses the name so you can type
// immediately; the full edit screen must NOT (autoFocus would fight the scroll + hide the preview).
// This per-surface difference is now a single prop on the shared component — lock both sides.
it('compact auto-focuses the name input', () => {
  renderFields({ variant: 'compact', autoFocusName: true, namePlaceholder: 'Category name' });
  expect(screen.getByPlaceholderText('Category name').props.autoFocus).toBe(true);
});

it('screen does NOT auto-focus the name input', () => {
  renderFields({ variant: 'screen' }); // edit screen passes no autoFocusName → defaults false
  expect(screen.getByPlaceholderText('e.g. Coffee runs').props.autoFocus).toBe(false);
});
