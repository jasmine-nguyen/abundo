---
target: app/(tabs)/budgets.tsx
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/maverick/src/abundo/app/(tabs)/budgets.tsx"
target_fingerprint: "sha256:2d3f152580d698061c9458b352d00e6629e3d3000a2b6fc7ff9d627650fa8fa1"
target_path: /Users/maverick/src/abundo/app/(tabs)/budgets.tsx
timestamp: 2026-10-03T12-38-32Z
slug: app-tabs-budgets-tsx
---
# Critique: Budgets tab, run 2 (after WHIT-706/707/708)
Method: dual-agent (A: design review · B: detector). Source-based; no Simulator. VoiceOver out of scope per owner.

## Design Health Score: 24/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | No pull-to-refresh; failed refresh over cached rows is silent (budgets.tsx:84) |
| 2 | Match System / Real World | 3 | "under pace", "over target", "borrowed" need translating |
| 3 | User Control and Freedom | 3 | Spread link nested inside row tap target |
| 4 | Consistency and Standards | 2 | Hero rounds (fmt) vs rows cents (fmtExact); "over" good on income, bad on spend; no pressed state on rows |
| 5 | Error Prevention | 3 | Delete confirmed now; edge states show wrong totals |
| 6 | Recognition Rather Than Recall | 3 | Legend caption scrolls away |
| 7 | Flexibility and Efficiency | 2 | No refresh, swipe actions or at-risk sort |
| 8 | Aesthetic and Minimalist Design | 2 | Up to 8 signals / ~5 colours per row |
| 9 | Error Recovery | 2 | No cause; nothing shown when cached rows exist |
| 10 | Help and Documentation | 2 | Legend caption only |

## Design Specificity
More product-specific than run 1 (pending named per row, spread link, payday countdown). Layout still category-generic. Hero omits pending; no tie to mortgage loop.
Detector: 0 findings (run 1: 11). Colour fixes confirmed. Detector does not parse RN style objects beyond raw colours; zero is weak evidence.

## Priority Issues
- [P1] Rows overloaded (budgets.tsx:24-56, context.tsx:2059-2075). Fix: default name+remaining+bar+one line; pace only when off pace; carryover/borrowed to detail. /impeccable distill
- [P1] Stale numbers silent, no pull-to-refresh (budgets.tsx:84, 91-96). Fix: RefreshControl via shared header; "Couldn't refresh · showing 9:40am". /impeccable harden
- [P2] Edge states wrong: income-only → $0 hero (context.tsx:2051); savings-only → "No budgets yet" (context.tsx:1995); "0 days left". /impeccable harden
- [P2] Good-vs-bad wording unclear: under pace, over target vs over, borrowed (context.tsx:2014, 2032, 2062-2063). /impeccable clarify
- [P2] Hero says "over" three times; pill reads backwards (budgets.tsx:121-122, 137-140). /impeccable layout
Note: equal 44pt days/money is the owner's deliberate choice; DESIGN.md (54pt + 30pt) is out of date.

## Persona Red Flags
- Daily glance: 8 items/row; spread link ~34pt nested; no pressed feedback.
- Edge tester: income-only $0; savings-only "No budgets yet"; silent failed refresh; whole $ vs cents; duplicate over amount.
- First-timer: "today's pace", "borrowed" unexplained.
- TestFlight partner: "under pace" praise?; "over" two meanings; detail title "Budget".

## Minor Observations
- VoiceOver labels missing (out of scope).
- Sub-budget 2pt left stripe on 20pt-radius card.
- 11–11.5pt labels at the floor.
- "SPENDING" label shows when it's the only section.
- Error copy gives no cause.

## Questions
- Hero as "what can I spend per day until payday?"
- Quiet rows by default; only off-pace rows speak up.
- Under-budget cycle end → "$180 spare → put it on the mortgage?"
