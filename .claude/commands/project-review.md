---
description: Deep design sweep of the whole Whittle app — hunt for critical design / architecture problems (not style nitpicks), then file one Notion card per confirmed issue, each with the decisions and open questions needed to fix it, into the "Project Review" folder. Read-only on code; the only writes are the Notion cards.
---

Do a deep, whole-app sweep of Whittle to find **critical design problems** before they
bite — the kind that are baked into how the app is built, not one-line bugs. For each
real issue, file a card in the **Project Review** Notion folder that explains it in plain
words and lays out the decisions/questions to solve it.

You are the orchestrator: read-only analysis agents do the hunting; YOU verify their
findings and file the cards. The ONLY thing you write is Notion cards under Project
Review — never touch code, never commit, never push.

**What counts as an issue here:** a design / architecture / data-model / correctness
weakness that could cause real harm — wrong money, lost or diverging data, a silent
failure, a security hole, a fragile integration, or a structure that will be painful to
change later. NOT style, naming, or small cleanups — `code-critic` owns craft on diffs.
When unsure, keep it only if you can name a concrete way it hurts a real user or a future
change.

---

## Phase 0 — Set up

1. **Load context so you don't re-report known things.**
   - Read AGENTS.md "Known landmines" and the latest **Build Note** Session Log.
   - Note what's already ticketed (e.g. the `WHIT-88` repository dedup, the `WHIT-136`
     constants shadow). Don't file these as new discoveries — reference them only if the
     sweep turns up a _new_ angle on them.
2. **Find or create the folder.** Search Notion for a page named **"Project Review"**
   under "Budget Tracker App" (page id `388ca73e-1d24-810f-8728-e82dc4dc8a86`). If it
   doesn't exist, create it there with a one-line intro. Every card is a child page of it
   (same shape as the "Test Cases" folder — one folder page, one child page per card).

## Phase 1 — Sweep (fan out, read-only)

Spawn read-only analysis agents in parallel, **one per area below**, so each stays focused
and their contexts don't blur. Give each the same rules: ground EVERY claim in real code
(cite `path:line`), hunt worst-first, and return a short structured list of candidate
issues (title · what · where · why it matters · rough severity). Skip nitpicks.

Areas to cover (adapt to what actually exists in the repo — drop any that don't apply,
add any the code suggests):

- **Money correctness** — rounding, currency, signs (income vs spend), pay-cycle and
  timezone math, off-by-one on dates/limits. Wrong numbers are the worst outcome.
- **Data model & persistence** — the shape of stored data, what survives a reload, schema
  changes / migrations, ids that must stay stable.
- **State & sync** — instant-vs-saved mismatches (the screen shows one thing, the server
  has another), offline behaviour, cross-device divergence, refresh ordering.
- **Bank integration** — how bank data flows in (webhooks, ids, safe-to-run-twice
  handling), and where it's fragile (e.g. the raw gateway-URL webhook target).
- **Failure modes** — network / server errors, partial failures: does the app fail loudly
  and honestly, or silently do the wrong thing / lie to the user?
- **Security & auth** — the biometric lock, tokens/secrets, the authorizer, any place user
  data could leak or a check could be skipped.
- **Backend structure** — Lambda boundaries, the shared layer, duplicated code that must
  change in lockstep, deploy/staging fragility.
- **Performance & scale** — unbounded lists, missing pagination, repeated work that grows
  with the user's data.
- **Test coverage of critical paths** — which money / sync / auth paths have NO safety net.

## Phase 2 — Verify (kill false alarms)

Before anything becomes a card, re-check it against the ACTUAL code yourself.

- Drop it if it's already handled, already ticketed, or you can't point at the real lines
  that show the problem. **No phantom issues** — a card must cite evidence.
- For anything you're unsure about, spawn a second read-only agent to try to REFUTE it. Keep
  it only if it survives.
- Merge duplicates that different areas found.

## Phase 3 — Present + confirm (quick stop before filing)

Show me a ranked table, worst-first: **issue · severity · one-line impact**. Lead with an
**"In plain words:"** summary of the top risks. Then ask:
**"File these as cards in Project Review? (or tell me which to drop / say 'file all')."**
Wait for my go before creating cards. (Point of the stop: don't bulk-create junk.)

## Phase 4 — File one card per confirmed issue

Create each as a child page of the Project Review folder. Title:
`<icon> <short plain title>` — icon `🏗️` design/architecture · `🐞` correctness bug ·
`🔒` security · `🔬` needs investigation. No `WHIT-` number yet (these aren't on the Board;
if one gets promoted to the Board later it gets a number then).

Each card body uses EXACTLY this structure, in plain language (AGENTS.md glossary — no
unexplained jargon):

```
## In plain words
2–3 sentences anyone (non-coder) understands: what's wrong and why we care.

## What & where
The problem, precisely, with the evidence: `path:line` references, short snippets.

## Why it matters
The concrete harm — wrong money / lost data / silent failure / security / future pain.
Who or what it hits, and when it would bite.
**Severity:** Critical | High | Medium   ·   **Confidence:** High | Medium | Low

## Decisions & open questions to solve it
The heart of the card. What has to be DECIDED before this can be fixed — use the
AGENTS.md "Presenting a decision" shape:
- **Problem** — one or two lines: what's undecided.
- **Options** — each with pros / cons; name the **recommended** one and why.
- **Open questions** — anything only Jasmine can answer (product intent, priorities).

## Rough effort & blast radius
Ballpark size (small / medium / large) and how much other code a fix would touch.
```

## Phase 5 — Wrap up

Post a short summary to me: how many areas swept, how many cards filed, and the top 3
risks in one line each. Link the Project Review folder.

---

## Hard rules

- **Read-only on code.** The only writes are Notion cards under Project Review. Never edit
  code, commit, push, or touch the Board.
- **Critical/design focus, not nitpicks.** If it's craft/style, it's not a card here.
- **Evidence or it doesn't ship.** Every card cites real `path:line`. No guessed problems.
- **Don't re-file known landmines** as new; reference existing tickets where relevant.
- **Plain language throughout** — every card leads with "In plain words" and carries no
  unexplained jargon (AGENTS.md glossary). Practise what you present: the whole point is
  that Jasmine can read a card and understand the risk without a code tour.
- **Stop before bulk-filing** (Phase 3). Don't create cards until I say go.
