---
target: app/(tabs)/budgets.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/Users/maverick/src/abundo/app/(tabs)/budgets.tsx"
target_fingerprint: "sha256:108c980a663cbadfb9042946ac4cda065a3fa32fba039efce6f2ea9a7a1f13f0"
target_path: /Users/maverick/src/abundo/app/(tabs)/budgets.tsx
timestamp: 2026-10-04T09-25-21Z
slug: app-tabs-budgets-tsx
---
# Critique: Budgets tab, run 3 (Simulator screenshots, after WHIT-712..716, 724)
Method: dual-agent (A: design review with screenshots · B: detector). VoiceOver out of scope.

## Design Health Score: 25/40 (Acceptable)
1 Status 3 · 2 Real world 2 · 3 Control 3 · 4 Consistency 2 · 5 Error prevention 2 · 6 Recognition 3 · 7 Efficiency 2 · 8 Minimalist 3 · 9 Recovery 3 · 10 Help 2
Detector: 0 findings; does not parse RN style objects (weak evidence).

## Priority Issues
- [P1] Over-budget rows buried at bottom (budgetViews order, context.tsx ~2091). Sort over → behind → rest; collapse $0 rows. /impeccable layout
- [P2] Spread-payback rows: "of $659" hides available −$659 (fmt drops sign, context.tsx:2060, :2959). Maths is correct by design (spread payback); copy only. /impeccable clarify
- [P2] Status bar bare when header hides (useScrollNavBars.ts:27-28 slides insets.top away). Fixed safe-area strip; shared ScrollChromeHeader. /impeccable adapt
- [P2] Category bar colours impersonate status (postedColor c.color, context.tsx:2064). Neutral under-budget fill. /impeccable colorize
- [P2] Top card: owner-chosen design — "$x / $y spent" + "Next payday …"; drop pill and "resets in N days". /impeccable layout

## Minor
- Large-text capture mostly a live-switch artifact; re-check after cold launch. Real risks: tab labels numberOfLines=1; 40pt header buttons.
- "behind pace" reads backwards.
- Duplicate glyphs Health/Insurance, Home Improvement/Mortgage.
- Ask button overlaps mid-list rows.

Note: owner confirmed spread/rollover totals are intended; no backend changes without asking.
