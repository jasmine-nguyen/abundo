// Shared Insights category fixtures for the colour-slot tests (WHIT-444).
//
// The Insights screen suites prove the screen paints from a category's stored colorSlot by
// giving `shopping` a slot and asserting the painted hue is the SLOT's, not the id fallback's.
// That only proves anything while the two disagree — so the exemplar `shopping` MUST carry a slot
// it does not own (2, not its seed 13). WHIT-432 aligned every built-in's fallback with its seed
// slot, which is exactly what would make a seed-slot fixture paint the same hue both ways and let
// the suites pass with the slot wiring deleted.

// The flat Spending fixture. No sub-categories.
export const PALETTE_CATS = [
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#73daca', bucket: 'Lifestyle', colorSlot: 2 },
  { id: 'eatingout', name: 'Eating Out', icon: 'food', color: '#e5495f', bucket: 'Lifestyle', colorSlot: 0 },
] as const;
