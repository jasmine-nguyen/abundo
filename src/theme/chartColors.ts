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
// low-saturation so the donut's temperature() classifies it neutral — reserved for "Other" only,
// never a real category. Same value as C.textFaint.
export const OTHER_COLOR = '#565f89';

// The chart surface / slice-divider token (Tokyo Night bg). Same value as C.bg.
export const CHART_BG = '#16161e';

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

// A category id → its chart colour on the Insights screen. Built-in → its fixed hue-ordered slot;
// unknown id → a stable hashed slot; null/blank id → the first ramp colour (a defensive path).
// Never returns OTHER_COLOR — that grey is reserved for the donut's grouped "Other".
export function chartCategoryColor(id: string | null | undefined): string {
  if (!id) return CATEGORY_COLORS[0];
  const builtin = BUILTIN_CATEGORY_INDEX[id];
  if (builtin !== undefined) return CATEGORY_COLORS[builtin];
  return CATEGORY_COLORS[categoryColorHash(id) % CATEGORY_COLORS.length];
}
