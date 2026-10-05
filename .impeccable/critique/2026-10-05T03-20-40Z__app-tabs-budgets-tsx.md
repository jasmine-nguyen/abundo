---
target: app/(tabs)/budgets.tsx
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "file:/Users/maverick/src/abundo/app/(tabs)/budgets.tsx"
target_fingerprint: "sha256:3aad08b42c382be3f58d514c168507b6595c81168ca19159538ce213b85675b3"
target_path: /Users/maverick/src/abundo/app/(tabs)/budgets.tsx
timestamp: 2026-10-05T03-20-40Z
slug: app-tabs-budgets-tsx
---
# Critique: Budgets tab, run 5 (AXe-driven Simulator screenshots incl. cold-launch large text; after WHIT-732..737)
Method: dual-agent (A: design review · B: detector). VoiceOver out of scope.

## Design Health Score: 27/40 (Acceptable)
1 Status 3 · 2 Real world 3 · 3 Control 3 · 4 Consistency 2 · 5 Error prevention 3 · 6 Recognition 3 · 7 Efficiency 2 · 8 Minimalist 3 · 9 Recovery 3 · 10 Help 2
Detector: 0 findings (weak evidence for RN).

## Flagged changes
- Spread link removed from rows: intended, 34a7364 (WHIT-733). Also discarded WHIT-734's tap-size work.
- "See what happened →" added then removed within WHIT-733 (285b289 → 34a7364).
- "· pending" on its own line: regression, afed6a9 (WHIT-735).
- Minus splits from amount at large text: older, 31b74d9 (WHIT-728).

## Priority Issues
- [P2] Pending line starts with "·" (context.tsx:2072-2073, budgets.tsx:28). /impeccable typeset
- [P2] "of" amount rounded vs exact remain (context.tsx:2072, theme.ts:125-128). /impeccable polish
- [P2] Large text: minus splits; hero "Next payday" wraps out of line (budgets.tsx:66-73). /impeccable adapt
- [P2] Past overspend unexplainable; breakdown likely needs backend — owner decision first. /impeccable clarify
- [P3] Hero numbers not equal: adjustsFontSizeToFit shrinks money column (budgets.tsx:83-84). /impeccable typeset

## Minor
- Over bars full red regardless of size; uneven 18pt tick band; tick on paid-off Mortgage; dim 12pt notes.
