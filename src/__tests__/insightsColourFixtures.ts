// Shared Insights category fixtures for the colour-slot tests (WHIT-444).
//
// The two Insights screen suites prove the screen paints from a category's stored colorSlot by
// giving `shopping` a slot and asserting the painted hue is the SLOT's, not the id fallback's.
// That only proves anything while the two disagree — so the exemplar `shopping` MUST carry a slot
// it does not own (2, not its seed 13). WHIT-432 aligned every built-in's fallback with its seed
// slot, which is exactly what would make a seed-slot fixture paint the same hue both ways and let
// the suites pass with the slot wiring deleted.
//
// The fixtures live here so builtinFallbackMirror.logic.test.ts [B4] can assert that invariant
// against these OBJECTS, rather than regex-parsing the .tsx files as text (WHIT-432 review).
// Change a slot below and [B4] reddens in the fast logic project, next to the reason.

// The flat Spending fixture (insightsChartPalette.screen.test.tsx). No sub-categories.
export const PALETTE_CATS = [
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#73daca', bucket: 'Lifestyle', recent: 0, colorSlot: 2 },
  { id: 'eatingout', name: 'Eating Out', icon: 'food', color: '#e5495f', bucket: 'Lifestyle', recent: 0, colorSlot: 0 },
] as const;

// The nested fixture (insightsSlotRows.screen.test.tsx): shopping with two children, so the
// synthetic "Directly in X" and refund rows can be checked. Slots 2/5/9 all resolve to distinct
// hues, so no row assertion can pass by coincidence.
export const SLOT_ROWS_CATS = [
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#111111', bucket: 'Lifestyle', recent: 0, parent: null, colorSlot: 2 },
  { id: 'shoes', name: 'Shoes', icon: 'bag', color: '#222222', bucket: 'Lifestyle', recent: 0, parent: 'shopping', colorSlot: 5 },
  { id: 'clothes', name: 'Clothes', icon: 'bag', color: '#333333', bucket: 'Lifestyle', recent: 0, parent: 'shopping', colorSlot: 9 },
] as const;
