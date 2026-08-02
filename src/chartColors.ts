// The Insights chart palette (WHIT — category chart palette). A 20-colour equi-luminant OKLCH ramp
// (every colour at L 0.765 / C 0.129, hue-ordered) so category slices on the Insights screen read as
// one family — no slice jumps out on weight the way the old mixed-weight hues did. Verbatim from
// Design; do NOT hand-tune individual hexes (they are a computed set — changing one breaks parity).
//
// Scope: this recolours the Insights pie + its category rows only. Budgets / Transactions still read
// the app-wide `colorForCategory` (src/context.tsx); rolling this out everywhere is a follow-up.
export const CATEGORY_COLORS = [
  '#f98f98', '#f9927e', '#f49964', '#e8a24f', '#d2ae45', '#b5bb51', '#8ec56f',
  '#6eca89', '#4ccda3', '#25cdbd', '#0bcbd3', '#25c7e6', '#47c1f5', '#65baff',
  '#82b4ff', '#98aeff', '#aba7ff', '#bf9ff8', '#d797e6', '#e991cc',
] as const;

// The neutral grey the donut folds small slices into ("Other"). Deliberately OUTSIDE the ramp and
// low-saturation so it reads as "not one thing" — reserved for "Other" only, never a real category.
// Same value as C.textFaint.
export const OTHER_COLOR = '#565f89';

// The chart surface / slice-divider token (Tokyo Night bg). Same value as C.bg.
// Consumer: SpendingDonut's ring track — the surface that shows through the gap between wedges,
// which is what makes that gap a divider. (WHIT-408 removed this as unused; WHIT-403 gives it its
// first consumer, so it comes back.)
export const CHART_BG = '#16161e';


// Slot → ramp position. A stored `colorSlot` is NOT a ramp index: the server hands out the LOWEST
// FREE slot, so two categories created back-to-back get 5 and 6 — adjacent hues that read as the
// same colour. This permutation is the indirection that pulls them apart (slots 0,1,2,3 → ramp
// 0,10,5,15). Do not sort, reverse, or regenerate it: the slots are PERSISTED, so changing this
// array repaints every category.
// Two counterparts must stay in step, neither of which a Jest run can see:
//   • shared/repository_category.py — _COLOR_SLOT_COUNT (the slot range the server assigns)
//   • tests/lambda_api/test_categories.py — a copy of this array, guarding the seed spread
// WHIT-406 tracks the cross-language guard; the permutation invariant itself is pinned below.
export const ASSIGNMENT_ORDER = [
  0, 10, 5, 15, 2, 7, 12, 17, 1, 3, 4, 6, 8, 9, 11, 13, 14, 16, 18, 19,
] as const;

// A raw colorSlot off the wire as a usable slot, or undefined when it is absent or unusable.
// Mirrors the server's _coerce_slot — necessary because PATCH /categories/{id} echoes the STORED
// value with no coercion, so a corrupt row reaches the client uncleaned.
// NOT a truthy check: slot 0 is VALID (it is Eating Out), and `raw || undefined` would drop it.
// Everything rejected here would otherwise index ASSIGNMENT_ORDER out of range and yield
// `undefined`, which reaches `stroke` on the donut wedge and `backgroundColor` on the category row
// as an INVISIBLE slice — no crash, but a category that silently disappears from the chart, which
// is why the guard stays. Note JS `%` keeps the sign, so a negative slot cannot be rescued by
// wrapping: -5 % 20 is -5.
export function normalizeColorSlot(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return raw >= 0 && raw < ASSIGNMENT_ORDER.length ? raw : undefined;
}

// The 13 built-in category ids → a DISTINCT ramp slot each, hue-ordered so warm categories
// (eating out, coffee, utilities) sit on the warm end and cool ones (transport, travel) on the cool
// end. Distinct indices ⇒ 13 distinct colours, forever — never the deterministic hash collision a
// blind djb2 % 20 would create (coffee/health/utilities would all land on one slot). Ids mirror the
// server's built-in category seed (shared/repository_category.py).
export const BUILTIN_CATEGORY_INDEX: Record<string, number> = {
  eatingout: 0, health: 1, coffee: 3, utilities: 4, groceries: 6, shopping: 8,
  travel: 10, fitness: 12, transport: 14, phonenet: 15, pets: 16, gifts: 17, subs: 18,
};

// Stable djb2 hash → a ramp slot for an UNKNOWN (user-created) id. Two custom ids can collide (rare,
// and unknowable at build time — acceptable); we hash across the full ramp so custom categories stay
// as distinct from each other as possible.
function categoryColorHash(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// A category's chart colour on the Insights screen.
// PREFERRED: its stored, permanent `colorSlot` resolved through ASSIGNMENT_ORDER — assigned once
// server-side, so adding or deleting a category can never repaint another one.
// FALLBACK (slot absent or unusable): the id-derived colour — built-in → its fixed slot, unknown id
// → a stable hashed slot, null/blank id → the first ramp colour. Kept ON PURPOSE: it makes deploy
// ordering a preference rather than a hard gate, so a client running ahead of the server degrades
// to EXACTLY today's colours instead of a broken chart.
// Never returns OTHER_COLOR — that grey is reserved for the donut's grouped "Other". A negative or
// out-of-range slot therefore falls back rather than going grey: painting a real category the
// reserved grey would read as a lumped-together bucket rather than a category of its own.
//
// The slot arrives in an options bag, not a second positional arg, so that `ids.map(chartCategory-
// Color)` cannot compile — `.map` passes the array INDEX as arg 2, which would silently resolve a
// list position as a colour slot and make a passing test prove nothing.
// `slot?: number` — validate at the boundary, type strictly inside. toCategory already guarantees
// Category.colorSlot is a normalised number|undefined, so a caller passing anything else (say a hex
// string) is a bug the compiler should catch, not one normalizeColorSlot should silently absorb.
// The runtime check stays: it still range-guards, and still catches a lying `any`.
export function chartCategoryColor(
  id: string | null | undefined,
  options?: { slot?: number },
): string {
  const stored = normalizeColorSlot(options?.slot);
  // `!== undefined`, not `if (stored)` — slot 0 is Eating Out, and truthiness eats it.
  if (stored !== undefined) return CATEGORY_COLORS[ASSIGNMENT_ORDER[stored]];
  if (!id) return CATEGORY_COLORS[0];
  const builtin = BUILTIN_CATEGORY_INDEX[id];
  if (builtin !== undefined) return CATEGORY_COLORS[builtin];
  return CATEGORY_COLORS[categoryColorHash(id) % CATEGORY_COLORS.length];
}
