# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

- **Primary:** the builder (Jasmine). She has an Australian mortgage, is paid on a pay cycle and is saving the equity toward an investment property. She opens the app daily to check spending and mortgage progress.
- **Secondary:** a few other people on TestFlight (partner, family, friends). They didn't build it, so screens must make sense without explanation.
- Not yet a public App Store product. Don't design first-run marketing, pricing or trust-building flows for strangers unless asked.

## Product Purpose

A budget tracker that is accurate (pending spend counts), nice to open every day, and built to motivate paying down the mortgage.

The loop: track → budget → set goals → knock down the mortgage → watch usable equity for the next property grow.

Success means the number on screen is right *now*, and paying down the mortgage feels like a game worth playing.

## Positioning

- **Pending spend counts against the budget.** Other apps (e.g. Frollo) only count settled transactions, so their budget is wrong until things settle.
- **The mortgage is the hero, not a net-worth line.** Payoff is broken into milestones, each showing the equity it unlocks. A push notification cheers every repayment. Usable equity (LVR × property value − loan balance) updates live.
- Unlike the alternatives: not expensive or plain (PocketSmith), not full of ads (MoneyMe).

## Operating Context

- Transactions sync automatically from the bank via BankSync. Nothing is entered by hand. Pending charges reconcile into their settled versions.
- Budgets are set per category, per pay cycle (weekly / fortnightly / monthly), anchored to payday rather than the 1st of the month.
- Category taxonomy: four buckets (Living, Lifestyle, Income, Savings) with sub-categories that roll up into the parent.
- Checked on the phone in short daily glances, plus deeper sessions around payday and repayments.
- Push notifications: budget alerts at 80% and 100%, repayment cheers, goal nudges. Each fires at most once per thing, per cycle.

## Capabilities and Constraints

- Tabs: Transactions, Budgets, Insights, Goals, Accounts. Detail routes cover the mortgage, loan, milestones, rules, categories and settings.
- Auto-categorisation rules by merchant. Notes, tags and "Not in budget" exclusion on transactions.
- Insights: per-cycle category breakdown with a tappable donut chart, this cycle vs last cycle, and an optional AI spending coach (Claude) that receives only category totals, and only on tap.
- Security: Cognito sign-in, a biometric lock (Face ID), and tokens kept in the secure store.
- Stack: Expo v56 / React Native / TypeScript, expo-router, React Query, react-native-svg charts and a shared token theme (`src/theme.ts`). The backend is Python Lambdas on AWS.
- **Australian context:** AUD, Australian banks, LVR, fortnightly pay is common. Use Australian spelling and terms (categorise, cheque, etc.).

## Brand Commitments

- Name: **Abundo** (renamed from the working title "Whittle"; some infra and Xcode names still say Whittle).
- **Tokyo Night theme is binding.** It's the brand's look, not just the current skin. Future work extends it, never replaces it.
- Mark: a tree (`assets/abundo-tree-mark.svg`), iOS icon `assets/abundo-icon-ios.svg`.
- **Voice: calm, never spammy.** Encouraging and celebratory about progress, never naggy, guilt-tripping or alarmist. This applies to in-app copy as well as notifications.

## Evidence on Hand

- Real user data comes from the builder's own bank sync. There are no testimonials, customers, press or metrics. Don't fabricate any.
- Brand assets: `assets/abundo-tree-mark.*`, `assets/abundo-icon-ios.*`, `assets/abundo-adaptive-foreground.*`.

## Product Principles

1. **Accurate now beats tidy later.** Show the true number, including pending spend, even when it's messy.
2. **Make progress feel earned.** Milestones, equity unlocked and repayment cheers turn the mortgage from a scary number into winnable sprints.
3. **Worth opening every day.** Daily glances should be quick and pleasant, never a chore or a wall of numbers.
4. **Calm, not noisy.** Every alert and nudge is rare, well-timed and kind.
5. **Private by default.** Only the minimum leaves the device, and only when asked (e.g. AI coach gets totals only).

## Accessibility & Inclusion

Existing practice, not a stated hard requirement: screen-reader labels, sensible focus, legible contrast (the chart's fixed slice fades in `src/chartColors.ts`), and motion that respects "reduce motion".
