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

type Node = { props: { onPress?: unknown } };

// [G1] Every icon in the grid must be wired to onIconChange(thatKey). The icon buttons carry no
// text/testID, so we isolate them structurally: with the bucket + parent pickers off, the ONLY
// Pressables left are the icon cells, in ICON_KEYS order. Pressing the 'car' cell (index 3) must
// report onIconChange('car'). Fail-on-revert: mis-wire the grid (e.g. onIconChange(icon) instead
// of onIconChange(k), or drop the handler) and the reported key is wrong / absent → red.
it('the icon grid reports the tapped icon key via onIconChange', () => {
  const { UNSAFE_root } = renderFields({ variant: 'compact', lockBucket: true, parentPicker: false });
  const iconCells = (UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] })
    .findAll((n) => typeof n.props?.onPress === 'function');
  // With buckets locked and no parent picker, the grid is the whole tappable surface.
  expect(iconCells.length).toBe(ICON_KEYS.length);
  const carIdx = ICON_KEYS.indexOf('car');
  fireEvent.press(iconCells[carIdx] as unknown as Parameters<typeof fireEvent.press>[0]);
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
