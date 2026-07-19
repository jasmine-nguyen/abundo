# Abundo

**A budget tracker that's accurate (pending spend counted), a pleasure to look at, and built to actually motivate you to pay down your mortgage — right down to the equity you're unlocking for the next place.**

> *Renamed from the working title “Whittle”. The app and its screens are now Abundo; some backend/infra names still carry the old name and are migrated separately.*

---

## Why I built it

I tried the apps that already exist, and each one missed something that mattered to me:

- **PocketSmith** — powerful, but **expensive**, and it just doesn't look good enough to want to open every day.
- **Frollo** — genuinely nice to look at, but it **doesn't count pending transactions against your budget**. So your budget is quietly *wrong* until everything settles — which, for real day-to-day tracking, defeats the whole point.
- **MoneyMe** — buried under **too many ads** to be something you want to open every day.
- **All of them** treat a mortgage as just another line on a net-worth screen. **None are built to actually motivate you to pay it down** — no milestone breakdown, no little hit of "you did it" when a repayment lands or you cross a milestone.

That last one is the whole reason this exists. I wanted a budget tracker that is:

1. **Accurate** — pending spend counts, so the number is right *now*, not after everything settles.
2. **Actually nice to use** — something I *want* to open.
3. **Built to make paying down the mortgage feel like a game worth playing** — the payoff broken into milestones, a push when I make a payment or hit one, and a live read on the **usable equity** I'm unlocking toward an investment property.

So the loop is: **track → budget → set goals → knock down the mortgage, and watch the equity for my next place grow.** That's the app.

---

## What it does

### 🏦 Bank-synced transactions, categorised for you
- Transactions sync automatically from the bank (via BankSync) — nothing is entered by hand.
- Pending charges reconcile into their settled versions automatically (no duplicates, no orphaned categories).
- A tidy **category taxonomy** with four buckets — **Living, Lifestyle, Income, Savings** — plus **sub-categories** (a parent budget rolls up everything beneath it).
- **Auto-categorisation rules**: teach it once (by merchant), and matching charges file themselves.
- Tap any charge to re-file it, add **notes and tags**, or **exclude it from budgets** ("mark as transfer") — with a quiet **"Not in budget"** tag so an exclusion is never a mystery.

### 📅 Pay-cycle budgets
- Budgets are set **per category, per pay cycle** — weekly, fortnightly, or monthly — anchored to *your* payday, not the 1st of the month.
- Spend ceilings for the things you want to cap, plus **income / earn-targets** (where over-is-good) and savings targets.
- Every budget resets cleanly when the next cycle rolls over.

### 📊 Spending insights
- A per-cycle **breakdown by category** — including a **donut chart** you can tap to pop out any slice and see that category's total.
- Flip between **this cycle** and **last cycle**.
- An optional **AI spending coach**: send your category totals to Claude (Anthropic) for a short, plain-language read on how you're pacing and where to trim.

### 🎯 Goals & mortgage payoff — the heart of it
This is the part the other apps don't do.
- **Mortgage payoff, broken into milestones** — so a scary six-figure number becomes a sequence of winnable sprints, each showing the **equity it unlocks**.
- A **celebratory push every time a repayment lands** — *"you just put $X toward the mortgage"* — the little hit of progress that turns paying it down into a game you *want* to play.
- **Usable equity for your next property**, calculated live: *your LVR × the property value, minus what you still owe.* Kill more principal → unlock more deposit. It updates as you go, so the deposit for an investment property visibly grows.
- A **pace** readout — "$X per payday to hit *[month]*" — so payoff is a plan, not a wish.
- Ordinary **savings goals** too, tracked the same motivating way.
- Home-loan facts underneath it all: balance, LVR, rate, repayments.

### 🔔 Nudges & alerts (push notifications)
Quiet, well-timed, and never spammy — each fires at most once per thing, per cycle:
- **Budget alerts** — a heads-up at **80%** of a category's budget, and again at **100%**.
- **Repayment alerts** — a little cheer when a home-loan repayment lands.
- **Goal nudges** — a gentle poke when a goal is falling behind its pace, or when a manually-tracked balance has gone stale.

### 🔒 Security & privacy
- Sign-in via **Cognito Hosted UI** (authorization-code + PKCE).
- **Biometric lock** (Face ID / fingerprint) on re-entry, with tokens kept in the device's secure store.
- The AI coach only ever sends **category totals**, and only when you tap to ask.

### 🎨 Design & feel
- A **Tokyo Night** theme throughout, with smooth motion that **respects "reduce motion"**.
- Built with accessibility in mind — screen-reader labels, sensible focus, legible contrast.

---

## Under the hood

**Client** — a mobile app built with **Expo / React Native** and **TypeScript**.
- `expo-router` for file-based navigation; **React Query** for a cached, self-healing data layer; a light context store for local UI state.
- Charts drawn with `react-native-svg`; a shared design-token theme.

**Backend** — **serverless on AWS**, written in **Python**.
- A **webhook receiver** ingests bank transactions, reconciles pending↔posted, and fires budget/repayment alerts inline.
- Supporting Lambdas: a **scheduled sync trigger**, a **balance poller**, a **goal-nudge** sweep, a **push-receipt** sweep, and a **pre-signup** hook.
- A **shared layer** holds the repositories and money logic used across functions.
- **DynamoDB** single-table store; **SSM** for secrets; **Expo Push** for notifications; **Terraform** for the infrastructure.

**Quality bar**
- Two test suites: **Jest** (a fast `logic` project + a `screen` project via React Native Testing Library) and **pytest** for the Lambdas.
- Coverage floors enforced in CI, and a **fail-on-revert** habit — a test that still passes when you undo the fix isn't a real test.

---

## Project layout

```
app/            Screens & navigation (expo-router): tabs + detail routes
src/            Client logic — context store, queries, components, theme, hooks
shared/         Python: repositories + money logic shared across Lambdas
lambda/         Webhook receiver (transaction ingest, reconcile, alerts)
lambda_api/     App-facing API (budgets, categories, goals, AI insights)
lambda_*/       Sync trigger · balance poller · goal nudge · push receipts · pre-signup
terraform/      Infrastructure as code
tests/          pytest suites (lambda + shared)
```

## Development

```sh
npm install
npm start                 # run the Expo app

npm test                  # fast client logic tests
npm run test:all          # full client suite (logic + screen)
npx tsc --noEmit          # client typecheck

python -m pytest          # backend (Lambda) tests
```

## Status & what's next

Actively built and running on TestFlight.

On the list:
- **Finish the rename** — the app is now **Abundo** (screens, name, icon). The remaining backend/infra names still carry the old "Whittle" and get migrated next.
- **A milestone-crossing celebration push** — today you get a cheer on every repayment; the natural next step is a bigger one the moment you *cross a payoff milestone*.
