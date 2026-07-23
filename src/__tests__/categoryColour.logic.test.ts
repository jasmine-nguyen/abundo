// WHIT-320: a category's display colour is a deterministic function of its id (Design's scheme).
// The 13 built-ins keep their CURRENT Tokyo Night hues (CATEGORY_BASE) — the pie looks identical
// to today. A 14th+ (user-created) category gets a darker OKLCH "sibling" instead of repeating a
// base colour, chosen by hashing the id so it's stable across cycles. This suite pins:
//   • seed ids → their exact current colour (no visible change to the existing pie),
//   • toCategory ignores the server-sent hex and derives colour from the id,
//   • non-seed ids → a deterministic, on-palette sibling,
//   • the OKLCH relationship (L×0.85, C×0.90) between each base and its sibling, so a hand-edited
//     token that drifts off that curve fails here rather than shipping a mismatched shade.
import { describe, it, expect } from '@jest/globals';
import {
  colorForCategory, CATEGORY_BASE, CATEGORY_SIBLINGS, PALETTE, toCategory,
} from '../context';

// A local sRGB↔OKLab pair so the sibling relationship is recomputed from scratch, independent of
// how the tokens were generated. If CATEGORY_SIBLINGS is edited by hand off the curve, [PIN] fails.
const cbrt = Math.cbrt;
function hexToOklab(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  let r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  r = lin(r); g = lin(g); b = lin(b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}
function oklabToHex(L: number, a: number, b: number): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gamma = (c: number) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  const to = (c: number) => Math.round(gamma(c) * 255).toString(16).padStart(2, '0');
  return '#' + to(R) + to(G) + to(B);
}
// Darker sibling: same hue, lightness ×0.85, chroma ×0.90 — the Design curve.
function sibling(hex: string): string {
  const [L, a, b] = hexToOklab(hex);
  const C = Math.hypot(a, b), H = Math.atan2(b, a);
  return oklabToHex(L * 0.85, C * 0.90 * Math.cos(H), C * 0.90 * Math.sin(H));
}

describe('colorForCategory — built-in categories keep today\'s colours', () => {
  it('every seed category maps to its current CATEGORY_BASE hue (no visible change)', () => {
    for (const [id, hex] of Object.entries(CATEGORY_BASE)) {
      expect(colorForCategory(id)).toBe(hex);
    }
  });

  it('covers all 13 built-in categories (the full server seed vocabulary)', () => {
    // These ids mirror shared/repository_category.py SEED_CATEGORIES — every seeded category has a
    // fixed base, so the pie can never fall through to a sibling for a built-in.
    const SEED_IDS = ['coffee', 'groceries', 'eatingout', 'transport', 'health', 'pets',
      'utilities', 'shopping', 'fitness', 'subs', 'travel', 'gifts', 'phonenet'];
    for (const id of SEED_IDS) {
      expect(CATEGORY_BASE[id]).toBeDefined();
      expect(colorForCategory(id)).toBe(CATEGORY_BASE[id]);
    }
    expect(Object.keys(CATEGORY_BASE).sort()).toEqual([...SEED_IDS].sort());
  });

  it('toCategory derives the colour from the id, ignoring whatever hex the server sent', () => {
    // The server still stores a legacy hex (#E8A87C for coffee); the client no longer trusts it.
    const c = toCategory({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' });
    expect(c.color).toBe(CATEGORY_BASE.coffee); // '#ff9e64', not the server's '#E8A87C'
  });
});

describe('colorForCategory — overflow (user-created) categories get a sibling', () => {
  it('a non-seed id resolves to one of the sibling tokens', () => {
    const c = colorForCategory('my-custom-category');
    expect(CATEGORY_SIBLINGS).toContain(c);
    expect(CATEGORY_BASE).not.toHaveProperty('my-custom-category');
  });

  it('is deterministic and stable — the same id always yields the same colour', () => {
    for (const id of ['brunch', 'side-hustle', 'kids', 'garden', 'wine', 'a', '']) {
      expect(colorForCategory(id)).toBe(colorForCategory(id));
    }
  });

  it('spreads distinct ids across more than one sibling (not a single fallback)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `cat-${i}`);
    const distinct = new Set(ids.map((id) => colorForCategory(id)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('a blank/null/undefined id falls back to the palette default', () => {
    expect(colorForCategory('')).toBe(PALETTE[0]);
    expect(colorForCategory(null)).toBe(PALETTE[0]);
    expect(colorForCategory(undefined)).toBe(PALETTE[0]);
  });
});

describe('CATEGORY_SIBLINGS — the OKLCH relationship to the base', () => {
  const baseHexes = Object.values(CATEGORY_BASE);

  it('[PIN] each sibling is the L×0.85 / C×0.90 OKLCH shade of the base at the same index', () => {
    expect(CATEGORY_SIBLINGS).toHaveLength(baseHexes.length);
    baseHexes.forEach((hex, i) => {
      expect(CATEGORY_SIBLINGS[i]).toBe(sibling(hex));
    });
  });

  it('every sibling is darker than its base (lower OKLab lightness)', () => {
    baseHexes.forEach((hex, i) => {
      expect(hexToOklab(CATEGORY_SIBLINGS[i])[0]).toBeLessThan(hexToOklab(hex)[0]);
    });
  });

  it('the base hues are all distinct and no sibling collides with a base', () => {
    const bases = new Set(baseHexes);
    expect(bases.size).toBe(baseHexes.length);                 // 13 distinct base colours
    for (const s of CATEGORY_SIBLINGS) expect(bases.has(s)).toBe(false); // siblings never equal a base
  });
});
