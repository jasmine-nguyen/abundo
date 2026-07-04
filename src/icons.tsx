import React from 'react';
import { SvgXml } from 'react-native-svg';

// Category glyphs ported verbatim from Whittle.dc.html (inner SVG, drawn with currentColor).
export const ICON: Record<string, string> = {
  coffee: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h12v4.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 9.5h2a2.2 2.2 0 0 1 0 4.4h-2"/><path d="M7 3v2M11 3v2"/></g>',
  cart: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/><path d="M3 4h2l2.1 11.2a1.5 1.5 0 0 0 1.5 1.2h8.1a1.5 1.5 0 0 0 1.5-1.2L20 8H6.2"/></g>',
  food: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11"/><path d="M16 3c-1.6 1-2.5 3-2.5 5.5 0 1.6 1 2.5 2.5 2.5V3zM16 11v10"/></g>',
  car: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l1.4-4.3A2 2 0 0 1 8.3 7.3h7.4a2 2 0 0 1 1.9 1.4L19 13M4.5 13h15v3.5h-15z"/><circle cx="8" cy="17.5" r="1.2"/><circle cx="16" cy="17.5" r="1.2"/></g>',
  health: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5h4l2-6 4 11 2-7 1.5 2H21"/></g>',
  pets: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="11" r="1.5"/><circle cx="10" cy="7.5" r="1.5"/><circle cx="14" cy="7.5" r="1.5"/><circle cx="17.5" cy="11" r="1.5"/><path d="M12 13c-2.6 0-4.8 2-4.8 4.2 0 1.5 1.4 2.3 4.8 2.3s4.8-.8 4.8-2.3C16.8 15 14.6 13 12 13z"/></g>',
  bolt: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/></g>',
  bag: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 11.5a1.5 1.5 0 0 1-1.5 1.3H8.5A1.5 1.5 0 0 1 7 19.5zM9 8V6.2a3 3 0 0 1 6 0V8"/></g>',
  home: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7M6.2 9.5V20h11.6V9.5"/></g>',
  film: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M8 5v14M16 5v14M3.5 9.5h4.5M16 9.5h4.5M3.5 14.5h4.5M16 14.5h4.5"/></g>',
  plane: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M21 4 3 11l6 2.5L11 20l3-5 7-11z"/><path d="M9 13.5 21 4"/></g>',
  gift: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11h14v8.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM4 8h16v3H4zM12 8v12.5"/><path d="M12 8S11 4.5 8.5 4.5a2 2 0 0 0 0 4zM12 8s1-3.5 3.5-3.5a2 2 0 0 1 0 4z"/></g>',
  phone: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/></g>',
  dumbbell: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5v5M6.5 7.5v9M17.5 7.5v9M20.5 9.5v5M6.5 12h11"/></g>',
  book: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5H16a1.5 1.5 0 0 1 1.5 1.5v13.5H7A1.5 1.5 0 0 1 5.5 18z"/><path d="M5.5 4.5A1.5 1.5 0 0 0 4 6v13.5"/></g>',
  tag: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 7.5 3.5 12 8l-4 4zM7.5 12.5l9-9 4 4-9 9z"/><circle cx="6" cy="6" r=".7" fill="currentColor"/></g>',
  q: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 9.3a2.9 2.9 0 0 1 5.5 1.1c0 1.9-2.7 2.3-2.7 4.2"/><circle cx="12" cy="18" r=".9" fill="currentColor" stroke="none"/></g>',
};

// 'tag' is the server's default icon (DEFAULT_CATEGORY_ICON) — include it so a
// category created without an icon renders and is pickable in the edit form.
export const ICON_KEYS = ['coffee', 'cart', 'food', 'car', 'health', 'pets', 'bolt', 'bag', 'home', 'film', 'plane', 'gift', 'phone', 'dumbbell', 'book', 'tag'];

// UI chrome glyphs (chevrons, plus, search, etc.) used outside the category set.
export const GLYPH: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
  search: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/></g>',
  chevron: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
  star: '<path d="M12 3l1.6 5.2L19 9.8l-4.4 3.2L16 19l-4-3.2L8 19l1.4-6L5 9.8l5.4-1.6z" fill="currentColor"/>',
  clock: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></g>',
  bell: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z"/><path d="M10 19.5a2 2 0 0 0 4 0"/></g>',
  logout: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H15M11 8l-4 4 4 4M7 12h11"/></g>',
  tag: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 7.5 3.5 12 8l-4 4zM7.5 12.5l9-9 4 4-9 9z"/><circle cx="6" cy="6" r=".7" fill="currentColor"/></g>',
  sliders: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></g>',
  calendar: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5"/></g>',
  arrowDown: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></g>',
  dollar: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 7h7a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8"/></g>',
  building: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5M5.5 9.5V20h13V9.5M9.5 20v-5h5v5"/></g>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  trash: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M9 6.5V4.5h6v2M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5"/></g>',
  wallet: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H18a1.5 1.5 0 0 1 1.5 1.5V9M4 8.5V18a2 2 0 0 0 2 2h12a1.5 1.5 0 0 0 1.5-1.5V13M19.5 9H16a2 2 0 0 0 0 4h3.5z"/></g>',
  target: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/></g>',
  // bottom-nav glyphs (ported from Whittle.dc.html)
  navBudgets: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v6.5"/></g>',
  navTx: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></g>',
  navGoals: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/></g>',
  navSettings: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.5 12a7.5 7.5 0 0 0-.13-1.4l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2.4-1.4L14.3 2.5h-4l-.4 2.4a7.5 7.5 0 0 0-2.4 1.4l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.8l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2.4 1.4l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.4-1.4l2.3 1 2-3.4-2-1.5c.08-.46.13-.92.13-1.4z"/></g>',
  navInsights: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 12V3.5"/><path d="M12 12l7.4 4.2"/></g>',
};

function wrap(inner: string, color: string): string {
  // react-native-svg resolves `currentColor` from the `color` prop, but inlining is the
  // most reliable across native + web, so substitute directly.
  return `<svg viewBox="0 0 24 24">${inner.replace(/currentColor/g, color)}</svg>`;
}

export function Icon({ name, size = 22, color = '#fff' }: { name: string; size?: number; color?: string }) {
  const inner = ICON[name] || ICON.q;
  return <SvgXml xml={wrap(inner, color)} width={size} height={size} />;
}

export function Glyph({ name, size = 20, color = '#fff' }: { name: string; size?: number; color?: string }) {
  const inner = GLYPH[name] || GLYPH.search;
  return <SvgXml xml={wrap(inner, color)} width={size} height={size} />;
}
