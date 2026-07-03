# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# Build state

Current state, decisions, and open work live in the Notion **Build Note**
(page "Build Note" under "Budget Tracker App") and the **Board**
(`collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`). At the start of a build
session, read the latest Session Log in the Build Note before acting.

# Pull request workflow

Open a pull request for every completed, meaningful unit of work — and before
the (ephemeral) container may time out — so Jasmine can review the code herself.
Always create the PR; don't wait to be asked. Keep unrelated changes on separate
branches/PRs so each one stays independently reviewable.

# How to communicate with Jasmine

When explaining, presenting ideas, or writing to Notion:

- Short sentences. To the point.
- Bullet points, not paragraphs. Avoid walls of text.
- Conditionals as: if X → then Y.
- Use arrows (→) to show flow / what happens.
- Draw a diagram when it helps (ASCII or mermaid).
- Plain language — no unexplained jargon. If a term is technical (UI/code/infra,
  e.g. "hero", "optimistic update", "idempotent"), explain it in everyday words
  or name the actual thing on screen (e.g. "the big 'days left' number").
- Applies to chat AND Notion writes.
