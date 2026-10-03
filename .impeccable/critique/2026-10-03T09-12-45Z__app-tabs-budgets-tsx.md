---
target: app/(tabs)/budgets.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/maverick/src/abundo/app/(tabs)/budgets.tsx"
target_fingerprint: "sha256:1330bb212c8c0a203885f3b4486369779253e72866928011bdc5b96bc476692e"
target_path: /Users/maverick/src/abundo/app/(tabs)/budgets.tsx
timestamp: 2026-10-03T09-12-45Z
slug: app-tabs-budgets-tsx
---
# Critique: Budgets tab (app/(tabs)/budgets.tsx)
Method: dual-agent (A: design review · B: detector). Source-based review; no Simulator capture.

## Design Health Score: 25/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | No pull-to-refresh (siblings have it); no last-updated |
| 2 | Match System / Real World | 3 | "Posted", "under pace", "borrowed" unexplained; income shows two "to go" figures |
| 3 | User Control and Freedom | 3 | Simple tab → detail → back |
| 4 | Consistency and Standards | 2 | + button unlabelled, 40pt; "Today's pace" vs "today's target"; grey legend vs coloured bars; raw colours |
| 5 | Error Prevention | 2 | Delete budget has no confirm/undo (app/budget/[id].tsx:33) |
| 6 | Recognition Rather Than Recall | 3 | Legend scrolls away |
| 7 | Flexibility and Efficiency | 2 | No urgency sort, swipe actions, or refresh |
| 8 | Aesthetic and Minimalist Design | 3 | One glow, calm; rows carry 6–7 items |
| 9 | Error Recovery | 2 | Generic "Couldn't load your budgets." |
| 10 | Help and Documentation | 2 | Legend is the only help |

## Design Specificity
Product-specific logic (payday countdown, posted+pending+pace bar, carryover/borrow, inverted income), category-generic layout. Pending spend — the product's edge — is the quietest element.
Detector: 11 advisory design-system-color findings (8 budgets.tsx, 3 shared: ui.tsx:74, ui.tsx:121, ScrollChromeHeader.tsx:60). 6 are drift from existing tokens (heroInkSoft, heroBlobFill, progressTrack). Agrees with LLM review.

## Priority Issues
- [P1] No empty state: zero budgets shows a $0 hero + legend for no bars (budgets.tsx:66-122). Fix: calm prompt + "Add your first budget". /impeccable harden
- [P1] VoiceOver unusable: no a11y props in budgets.tsx; + unlabelled, 40pt no hitSlop (:49). Fix: one label per row, label + hitSlop. /impeccable audit
- [P2] Income rows confuse: two "to go" values (context.tsx:2018 vs 2027), even-pace assumption, excluded from hero total. Fix: Spending/Earning sections, "$X earned · next pay ~Fri". /impeccable clarify
- [P2] Pending spend has no words: merged into "spent" (context.tsx:2058); grey legend scrolls away. Fix: "$320 spent · $45 pending"; inline caption. /impeccable clarify
- [P2] Over budget piles on rose, no way forward: 4 rose elements; hero has no next step; Spread buried in detail. Fix: rose on amount+bar only; "Spread it over pay cycles →"; "Over by $120 · resets in 4 days". /impeccable polish

## Persona Red Flags
- Daily glance: biggest number is days not money; no refresh; no urgency sort; small top + button.
- VoiceOver: unlabelled +, rows not buttons, pending visual-only, tab bar lacks selected state (_layout.tsx:66).
- Edge tester: "1 days left"; $0 hero; delete without confirm; "per fortnight" for all users (pick.tsx:28).
- TestFlight partner: jargon unexplained; hero total ≠ sum of rows.

## Minor Observations
- Carryover line in accentSoft looks tappable (One Tint rule) (budgets.tsx:158).
- 11–11.5pt labels at the iOS floor.
- Hero lacks next payday date.
- DESIGN.md wrongly says text is fixed-size; RN scales by default; fixed lineHeight 54 (:138) and height 18 (:164) will clip at large sizes.

## Questions
- Should the hero number be money left instead of days left?
- Why is pending spend the quietest thing on screen?
- What if under-pace fed the mortgage game?
