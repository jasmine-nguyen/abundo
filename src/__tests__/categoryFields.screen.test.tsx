// WHIT-239 — CategoryFields, the ONE shared implementation of the category field controls
// (name / bucket / parent / icon), consumed by both QuickCreateCategory (compact) and the
// category-edit screen (screen). Like quickCreateCategory.screen.test.tsx it uses only pure
// context exports, so we render it against the REAL context module — no mock — and assert:
//   (1) it is CONTROLLED — every tap reports back via a callback, it holds no state;
//   (2) it has NO drop-effect of its own (the fail-on-revert guard that stops the WHIT-244
//       loop-prone parent-drop from ever being pulled into the shared, controlled component);
//   (3) the two variants keep their per-surface differences (which labels show, "None" vs
//       "None (top-level)"), and the parent block hides identically when nothing is eligible.
// WHIT-459 folded in the full-parent greying tests (WHIT-441): the COMPONENT-level ones
// (categoryFieldsFullParent, same no-mock regime as here) and the SCREEN-level ones
// (categoryFullParent, which mounts app/category/edit behind the module mocks below). See the
// // ===== headers at the END.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { CategoryFields } from '../components/CategoryFields';
import { ICON_KEYS } from '../icons';
import { Bucket, Category, MAX_CHILDREN_PER_CATEGORY } from '../context';
import { cat } from './factory';

// WHIT-459: the categoryFullParent suite (folded at the END) mounts the app/category/edit SCREEN,
// which needs these three module mocks. CategoryFields is PURE-PRESENTATIONAL (it uses no context /
// query / router hook — only the pure exports eligibleParents / childCount / BUCKETS), so mounting the
// COMPONENT directly in the categoryFields + categoryFieldsFullParent suites is UNAFFECTED: the mocks
// are INERT for them (requireActual keeps every pure context export real; useAppContext / useCategories
// / useRouter are simply never called from the component).
const mockSaveCategory = jest.fn(async (_id: string | null, _form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, deleteCategory: jest.fn(), showToast: jest.fn(), getSessionEpoch: () => 0 }) };
});

let mockCategories: Category[] = [];
const mockCategory = (id: string | null) => mockCategories.find((c) => c.id === id);
jest.mock('../../src/queries', () => ({
  useCategories: () => ({ category: mockCategory, categories: mockCategories, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ categoryId: 'coffee' }),
}));

import CategoryEdit from '../../app/category/edit';

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

// --- WHIT-239 adversarial gaps (folded in): the icon-grid wiring + per-surface autoFocus -----

// [G1] Every icon in the grid is wired to onIconChange(thatKey), and every ICON_KEYS icon
// renders. WHIT-247: each cell carries an `icon-<key>` testID, so we tap it directly instead of
// walking the render tree. Fail-on-revert: mis-wire the grid (onIconChange(icon) instead of
// onIconChange(k), or drop the handler) → red.
it('the icon grid reports the tapped icon key via onIconChange', () => {
  renderFields({ variant: 'compact', lockBucket: true, parentPicker: false });
  expect(screen.getAllByTestId(/^icon-/)).toHaveLength(ICON_KEYS.length);   // every icon renders
  fireEvent.press(screen.getByTestId('icon-car'));
  expect(handlers.onIconChange).toHaveBeenCalledWith('car');
  expect(handlers.onIconChange).toHaveBeenCalledTimes(1);
});

// [G2] The compact form (categorise sheet / inline sub) auto-focuses the name so you can type
// immediately; the full edit screen must NOT (autoFocus would fight the scroll + hide the preview).
it('compact auto-focuses the name input', () => {
  renderFields({ variant: 'compact', autoFocusName: true, namePlaceholder: 'Category name' });
  expect(screen.getByPlaceholderText('Category name').props.autoFocus).toBe(true);
});

it('screen does NOT auto-focus the name input', () => {
  renderFields({ variant: 'screen' }); // edit screen passes no autoFocusName → defaults false
  expect(screen.getByPlaceholderText('e.g. Coffee runs').props.autoFocus).toBe(false);
});

// ===== WHIT-459: folded from categoryFieldsFullParent.screen.test.tsx (WHIT-441 full-parent greying, COMPONENT-level, 3 its) =====
// Same regime as the suites above: renders the <CategoryFields/> COMPONENT directly. Its
// onParentChange / kids / renderPicker are block-scoped so they cannot collide with the survivor.
describe('categoryFieldsFullParent', () => {
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
});

// ===== WHIT-459: folded from categoryFullParent.screen.test.tsx (WHIT-441 full-parent greying, SCREEN-level, 2 its) =====
// DIFFERENT regime: mounts the app/category/edit SCREEN (CategoryEdit), driven by the module-scope
// context / queries / expo-router mocks hoisted at the top. Its local `cat` shadows the imported
// factory `cat` within this block only; the mocks it needs are INERT for the component suites above.
describe('categoryFullParent', () => {
const cat = (id: string, parent: string | null): Category =>
  ({ id, name: id, bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0, parent });
const childrenOf = (parent: string, n: number, prefix: string): Category[] =>
  Array.from({ length: n }, (_, i) => cat(`${prefix}${i}`, parent));

beforeEach(() => { mockSaveCategory.mockClear(); });

it('greys out a parent at the child cap, and a tap on it does nothing', () => {
  // 'treats' already holds the maximum children; 'coffee' (top-level, being edited) is not one of
  // them, so attaching it would overflow — the chip must be disabled.
  mockCategories = [
    cat('coffee', null),
    cat('treats', null),
    ...childrenOf('treats', MAX_CHILDREN_PER_CATEGORY, 'kid'),
  ];
  render(<CategoryEdit />);

  expect(screen.getByText('treats · full')).toBeTruthy();     // greyed + labelled
  fireEvent.press(screen.getByTestId('parent-treats'));        // disabled → no-op
  act(() => { fireEvent.press(screen.getByText('Save category')); });

  // Fail-on-revert: drop the `full`/disabled logic → the tap selects 'treats' → parent:'treats'.
  expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: null }), { silent: true });
});

it('keeps the category’s OWN full parent selectable — a plain rename never detaches it', () => {
  // 'coffee' already sits under 'treats', which is at the cap (coffee is one of its 50 children).
  // From coffee's side treats is NOT full — re-saving under it adds nothing — so it must stay
  // pickable. This is the landmine: greying the held parent would let a rename drop the link.
  mockCategories = [
    cat('coffee', 'treats'),
    cat('treats', null),
    ...childrenOf('treats', MAX_CHILDREN_PER_CATEGORY - 1, 'kid'),   // + coffee = 50
  ];
  render(<CategoryEdit />);

  expect(screen.queryByText('treats · full')).toBeNull();     // held parent is never greyed
  // Deselect then re-pick the held parent, then save: it must land back on 'treats'.
  fireEvent.press(screen.getByText('None (top-level)'));
  fireEvent.press(screen.getByTestId('parent-treats'));
  act(() => { fireEvent.press(screen.getByText('Save category')); });

  // Fail-on-revert: drop the `p.id !== heldParentId` guard → treats is greyed + disabled → the
  // re-pick is a no-op → save writes parent:null → this assertion fails.
  expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: 'treats' }), { silent: true });
});
});
