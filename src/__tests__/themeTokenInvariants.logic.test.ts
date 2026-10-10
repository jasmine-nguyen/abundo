/// <reference types="node" />
// WHIT-398 / WHIT-460 — tint() slices the six hex digits after '#'. Hand it a token that is ALREADY
// an rgba string and it silently returns 'rgba(NaN,…)': an invisible element, no throw, no type
// error. This scans every shipped tint(C.x, a) call site and checks each token it reaches is a hex.
import { describe, it, expect } from '@jest/globals';
import { C, tint } from '../theme';
import { shippedCode } from './support/sourceScan';

const TINT_TOKEN_CALL = /tint\(\s*C\.([A-Za-z0-9_]+)\s*,/g;
const CODE = shippedCode();

function matchesAcross(re: RegExp): { file: string; capture: string }[] {
  const hits: { file: string; capture: string }[] = [];
  for (const [file, src] of CODE) {
    for (const m of src.matchAll(new RegExp(re.source, 'g'))) hits.push({ file, capture: m[1] });
  }
  return hits;
}

// ---- [G3] no tint() call site can silently produce rgba(NaN,NaN,NaN,a) --------------------------
describe('[G3] every tint(C.…) call site is handed a #rrggbb token', () => {
  // tint() slices the first six characters after '#'. Hand it one of the tokens that is ALREADY an
  // rgba string (C.hairline, C.hairlineStrong) and it returns the string 'rgba(NaN,NaN,NaN,0.5)' —
  // no throw, no type error, just an invisible element. This card multiplied tint(C.x, a) call
  // sites by 52, so the idiom is now everywhere; this keeps the trap shut.
  const tokens = [...new Set(matchesAcross(TINT_TOKEN_CALL).map((h) => h.capture))].sort();

  it('finds the tokens it is meant to be checking', () => {
    expect(tokens).toContain('accentAlt');
    // Deliberately NOT asserting 'accent' here. WHIT-398 moved AiCoachCard — the last production
    // tint(C.accent, …) call site — onto accentAlt, so that token now reaches tint() only from
    // inside theme.ts. Pinning a second specific name would just go stale the same way.
    expect(tokens.length).toBeGreaterThan(2);
    // and the trap is real, not hypothetical
    // C.hairline is already an rgba() string; tint() slices it as if it were hex and emits
    // 'rgba(NaN,186,NaN,0.5)' — a silently invisible element, no throw, no type error.
    expect(tint(C.hairline, 0.5)).toContain('NaN');
  });

  it.each(tokens)('[G3] C.%s is a #rrggbb hex, so tint() of it is a real colour', (token) => {
    const value = (C as unknown as Record<string, string>)[token];
    expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tint(value, 0.16)).not.toContain('NaN');
  });
});
