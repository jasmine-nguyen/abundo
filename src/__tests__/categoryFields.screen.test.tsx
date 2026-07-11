// WHIT-239 — CategoryFields, the ONE shared implementation of the category field controls
// (name / bucket / parent / icon), consumed by both QuickCreateCategory (compact) and the
// category-edit screen (screen). Like quickCreateCategory.screen.test.tsx it uses only pure
// context exports, so we render it against the REAL context module — no mock — and assert:
//   (1) it is CONTROLLED — every tap reports back via a callback, it holds no state;
//   (2) it has NO drop-effect of its own (the fail-on-revert guard that stops the WHIT-244
//       loop-prone parent-drop from ever being pulled into the shared, controlled component);
//   (3) the two variants keep their per-surface differences (which labels show, "None" vs
//       "None (top-level)"), and the parent block hides identically when nothing is eligible.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CategoryFields } from '../components/CategoryFields';
import { Bucket, Category } from '../context';
import { cat } from './factory';

const handlers = {
  onNameChange: jest.fn(),
  onBucketChange: jest.fn(),
  onIconChange: jest.fn(),
  onParentChange: jest.fn(),
};
beforeEach(() => { Object.values(handlers).forEach((h) => h.mockClear()); });

// Sensible defaults; each test overrides what it exercises. Screen variant by default (the
// fuller surface, which labels its name+bucket rows); tests that need the compact contract
// pass variant='compact' explicitly.
function renderFields(over: Partial<React.ComponentProps<typeof CategoryFields>> = {}) {
  return render(
    <CategoryFields
      variant="screen"
      name={over.name ?? ''}
      namePlaceholder={over.namePlaceholder ?? 'e.g. Coffee runs'}
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

// --- Controlled contract: taps report back, no internal state -----------------------------

it('is controlled: typing the name reports via onNameChange', () => {
  renderFields();
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Parking');
  expect(handlers.onNameChange).toHaveBeenCalledWith('Parking');
});

it('is controlled: tapping a bucket reports via onBucketChange', () => {
  renderFields({ bucket: 'Living' });
  fireEvent.press(screen.getByText('Lifestyle'));
  expect(handlers.onBucketChange).toHaveBeenCalledWith('Lifestyle');
});

it('is controlled: tapping a parent reports via onParentChange', () => {
  const cats: Category[] = [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null })];
  renderFields({ parentPicker: true, categories: cats, bucket: 'Living' });
  fireEvent.press(screen.getByText('Car'));
  expect(handlers.onParentChange).toHaveBeenCalledWith('car');
});

// The critical fail-on-revert: CategoryFields must NOT drop a now-ineligible parent itself —
// that effect lives in each host (QuickCreate / edit). If someone moves the parent-drop into
// this controlled component, changing the bucket prop would fire onParentChange(null) here and
// this test goes red — which is exactly the re-entrancy that caused the WHIT-244 loop.
it('does NOT self-clear the parent when the bucket prop changes (effect stays in the host)', () => {
  const cats: Category[] = [
    cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
    cat({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', parent: null }),
  ];
  const { rerender } = renderFields({ parentPicker: true, categories: cats, parent: 'car', bucket: 'Living' });
  // Switch the bucket under a Living parent — a host WOULD drop it, but the field cluster must not.
  rerender(
    <CategoryFields
      variant="screen"
      name=""
      namePlaceholder="e.g. Coffee runs"
      bucket="Lifestyle"
      icon="coffee"
      parent="car"
      categories={cats}
      editId={null}
      noneLabel="None (top-level)"
      parentPicker
      onNameChange={handlers.onNameChange}
      onBucketChange={handlers.onBucketChange}
      onIconChange={handlers.onIconChange}
      onParentChange={handlers.onParentChange}
    />,
  );
  expect(handlers.onParentChange).not.toHaveBeenCalled();
});

// --- Per-variant differences ---------------------------------------------------------------

it('screen variant labels the name + bucket rows; compact variant does not', () => {
  const s = renderFields({ variant: 'screen' });
  expect(s.getByText('CATEGORY NAME')).toBeTruthy();
  expect(s.getByText('BUCKET')).toBeTruthy();
  s.unmount();

  renderFields({ variant: 'compact', namePlaceholder: 'Category name' });
  expect(screen.queryByText('CATEGORY NAME')).toBeNull();
  expect(screen.queryByText('BUCKET')).toBeNull();
  // ICON is shared by both surfaces, so it stays regardless.
  expect(screen.getByText('ICON')).toBeTruthy();
});

it('uses the variant-specific noneLabel on the parent picker', () => {
  const cats: Category[] = [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null })];
  const s = renderFields({ variant: 'screen', parentPicker: true, categories: cats, noneLabel: 'None (top-level)' });
  expect(s.getByText('None (top-level)')).toBeTruthy();
  expect(s.queryByText('None')).toBeNull(); // exact-match: the screen label is not bare "None"
  s.unmount();

  renderFields({ variant: 'compact', parentPicker: true, categories: cats, noneLabel: 'None', namePlaceholder: 'Category name' });
  expect(screen.getByText('None')).toBeTruthy();
});

it('screen variant renders all four buckets when not locked', () => {
  renderFields({ variant: 'screen' });
  for (const b of ['Living', 'Lifestyle', 'Income', 'Savings']) {
    expect(screen.getByText(b)).toBeTruthy();
  }
});

it('lockBucket hides every bucket chip (compact new-sub case)', () => {
  renderFields({ variant: 'compact', lockBucket: true, namePlaceholder: 'Category name' });
  for (const b of ['Living', 'Lifestyle', 'Income', 'Savings']) {
    expect(screen.queryByText(b)).toBeNull();
  }
});

// --- Parent block hides identically on both variants when nothing is eligible ---------------

it('hides the parent block on BOTH variants when parentPicker is on but no parent is eligible', () => {
  // Empty taxonomy → eligibleParents returns nothing → the whole PARENT block must not render.
  const s = renderFields({ variant: 'screen', parentPicker: true, categories: [] });
  expect(s.queryByText('PARENT (OPTIONAL)')).toBeNull();
  expect(s.queryByText('None (top-level)')).toBeNull();
  s.unmount();

  renderFields({ variant: 'compact', parentPicker: true, categories: [], noneLabel: 'None', namePlaceholder: 'Category name' });
  expect(screen.queryByText('PARENT (OPTIONAL)')).toBeNull();
  expect(screen.queryByText('None')).toBeNull();
});
