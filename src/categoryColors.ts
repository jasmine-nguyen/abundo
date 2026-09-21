// The app-wide category palette (WHIT-422 / WHIT-320), moved out of the ~3,100-line store in
// src/context.tsx so the store stops doubling as a colour palette and its raw-colour ratchet
// exemption can be dropped. This is the source of truth for a category's display colour in the
// budgets, transactions and legend rows. (The Insights pie has its own separate OKLCH ramp in
// src/chartColors.ts.)
import { C } from './theme';
import type { Bucket } from './context';

export const BUCKET_COLOR: Record<Bucket, string> = {
  Living: '#7aa2f7', Lifestyle: '#bb9af7', Income: C.good, Savings: '#73daca',
};
// Warm/cool-alternating so consecutively-created categories never land on two neighbouring cool
// hues (the old order clustered cyan/teal/sky). PALETTE[0] stays '#ff9e64' — the fallback default.
export const PALETTE = ['#ff9e64', '#7aa2f7', '#f7768e', '#73daca', '#e0af68', '#bb9af7', '#ff75a0', '#2ac3de', '#9ece6a', '#b4a5f7'];

// Category colours (WHIT-320). A category's display colour is a deterministic function of its id,
// so it's stable across cycles and identical everywhere (pie slice, legend row, budgets, txns).
// The 13 built-in categories have fixed Tokyo Night hues (CATEGORY_BASE) — these are the app's
// CURRENT colours, unchanged. A category BEYOND the built-ins (a user-created one) gets a darker
// "sibling" of one of those hues (OKLCH: lightness −15%, chroma −10%), chosen by hashing its id —
// so extra categories stay on-palette and read as a distinct shade instead of repeating a base
// colour. Design's scheme; extends the palette from 13 to a durable ~26 before anything folds to
// the neutral "Other" grey the donut already uses.
export const CATEGORY_BASE: Record<string, string> = {
  coffee: '#ff9e64', groceries: '#9ece6a', eatingout: '#e5495f', transport: '#7aa2f7',
  health: '#ff75a0', pets: '#bb9af7', utilities: '#e0af68', shopping: '#73daca',
  fitness: '#7dcfff', subs: '#cba6f7', travel: '#2ac3de', gifts: '#9d7cd8', phonenet: '#b4a5f7',
};

// Darker sibling of each CATEGORY_BASE value, in the same order. Static tokens (no runtime colour
// library); the OKLCH relationship to the base is pinned by a test so the two can't drift.
export const CATEGORY_SIBLINGS = [
  '#d17d4a', '#7da64f', '#bc3349', '#5f81cb', '#d15980', '#977aca', '#b68c4d',
  '#56b0a3', '#5fa7d0', '#a484ca', '#039db5', '#7e61b1', '#9083ca',
];

// A small stable string hash (djb2), so a non-seed category's sibling is deterministic from its id.
function categoryColorHash(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// The display colour for a category id: a built-in's fixed base, else a deterministic darker
// sibling. Null/blank id falls back to the palette default.
export function colorForCategory(id: string | null | undefined): string {
  if (!id) return PALETTE[0];
  return CATEGORY_BASE[id] ?? CATEGORY_SIBLINGS[categoryColorHash(id) % CATEGORY_SIBLINGS.length];
}
