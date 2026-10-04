---
target: app/(tabs)/budgets.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/maverick/src/abundo/app/(tabs)/budgets.tsx"
target_fingerprint: "sha256:1ebfe936079403f89a5481b4599db78a282dc07fc7609cbbc21d35f8e6d64ae3"
target_path: /Users/maverick/src/abundo/app/(tabs)/budgets.tsx
timestamp: 2026-10-04T11-56-59Z
slug: app-tabs-budgets-tsx
---
# Critique: Budgets tab, run 4 (Simulator screenshots incl. cold-launch large text; after WHIT-726..731)
Method: dual-agent (A: design review · B: detector). VoiceOver out of scope.

## Design Health Score: 25/40 (Acceptable)
1 Status 3 · 2 Real world 2 · 3 Control 3 · 4 Consistency 2 · 5 Error prevention 3 · 6 Recognition 3 · 7 Efficiency 2 · 8 Minimalist 2 · 9 Recovery 3 · 10 Help 2
Detector: 0 findings (weak evidence for RN).

Fixed since run 3: over-budget first, status-bar strip, neutral bars, minus sign, slim $0 rows, "over plan" wording, large text OK after cold launch.

## Check with owner
- Top card is three columns (WHIT-731, PR #679), not the two quiet lines chosen for WHIT-726. Confirm intent.

## Priority Issues
- [P1] Amber "over plan" on nearly every row (context.tsx:2066); tick vs words use different bases on rollover/spread rows (context.tsx:2024 vs budgetMath.ts:13-15). /impeccable quieter
- [P1] Utilities rollover overspend: no amount in note, no way out (spread hidden for rollover, context.tsx:2888). Client-only fix. /impeccable clarify
- [P2] Ask button covers row content / spread link at rest (_layout.tsx:91). /impeccable layout
- [P2] Spread link ~31pt tap target inside row tap area (budgets.tsx:56, 265). /impeccable harden

## Minor
- Extra rollover notes from WHIT-728 (past overspend/leftovers) — confirm wanted.
- Slim row padding misaligned; top card mixed precision; sub-line wraps before "pending"; Health/Insurance same icon (category data — may be backend); tab labels 10.5pt.
