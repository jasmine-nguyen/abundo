// WHIT-441 item 1 (gaps) — the full-parent greying lives in the SHARED CategoryFields, so it must
// behave for BOTH hosts. The implementer's categoryFullParent suite drives the edit host (held
// parent present). These pin the component contract the QuickCreate host relies on — heldParentId
// defaults to null, so QuickCreate has NO exempt parent — plus the 49-vs-50 boundary at the chip.
// Rendered against the REAL context (pure exports only), matching categoryFields.screen.test.tsx.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { CategoryFields } from '../components/CategoryFields';
import { Bucket, Category, MAX_CHILDREN_PER_CATEGORY } from '../context';
import { cat } from './factory';

const onParentChange = jest.fn();
beforeEach(() => { onParentChange.mockClear(); });

const kids = (parent: string, n: number) =>
  Array.from({ length: n }, (_, i) => cat({ id: `${parent}-k${i}`, name: `k${i}`, bucket: 'Living', parent }));

// heldParentId is OMITTED here → it defaults to null, exactly the QuickCreate contract.
function renderPicker(cats: Category[], over: Partial<React.ComponentProps<typeof CategoryFields>> = {}) {
  return render(
    <CategoryFields
      variant="screen" name="" namePlaceholder="e.g. Coffee runs" bucket={'Living' as Bucket}
      icon="coffee" parent={null} categories={cats} editId={null} noneLabel="None (top-level)"
      parentPicker
      onNameChange={jest.fn()} onBucketChange={jest.fn()} onIconChange={jest.fn()}
      onParentChange={onParentChange} {...over}
    />,
  );
}

it('QuickCreate case (no held parent): a parent at the cap is greyed and un-tappable', () => {
  const cats = [cat({ id: 'treats', name: 'Treats', bucket: 'Living', parent: null }), ...kids('treats', MAX_CHILDREN_PER_CATEGORY)];
  renderPicker(cats);
  expect(screen.getByText('Treats · full')).toBeTruthy();
  fireEvent.press(screen.getByTestId('parent-treats'));           // disabled → no callback
  // Fail-on-revert: drop the `disabled={full}` / childCount guard → this fires → assertion fails.
  expect(onParentChange).not.toHaveBeenCalled();
});

it('a parent one short of the cap (49) is NOT greyed and stays tappable', () => {
  const cats = [cat({ id: 'treats', name: 'Treats', bucket: 'Living', parent: null }), ...kids('treats', MAX_CHILDREN_PER_CATEGORY - 1)];
  renderPicker(cats);
  expect(screen.queryByText('Treats · full')).toBeNull();         // boundary: 49 < 50
  fireEvent.press(screen.getByTestId('parent-treats'));
  expect(onParentChange).toHaveBeenCalledWith('treats');
});

it('the held parent is exempt at the component level even when full (the landmine, unit-scoped)', () => {
  const cats = [cat({ id: 'treats', name: 'Treats', bucket: 'Living', parent: null }), ...kids('treats', MAX_CHILDREN_PER_CATEGORY)];
  renderPicker(cats, { heldParentId: 'treats' });
  // Fail-on-revert: drop the `p.id !== heldParentId` guard → 'Treats · full' appears + tap no-ops.
  expect(screen.queryByText('Treats · full')).toBeNull();
  fireEvent.press(screen.getByTestId('parent-treats'));
  expect(onParentChange).toHaveBeenCalledWith('treats');
});
