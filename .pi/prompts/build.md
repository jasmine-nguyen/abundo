---
description: Run the build graph for a card or request
argument-hint: "[card ID, request, or resume]"
---
Read `.claude/commands/build.md` and follow it. Its ARGUMENTS are what the user typed after
`/build`, here: ${@:-(empty)}

It's written for Claude Code; you're in Pi, so these parts change:

- **Helpers run through Pi.** `build_graph.py` sees it was started from Pi and runs every helper
  with Pi, on the model picked in this session. Don't set `BUILD_RUNNER` or `BUILD_MODEL`
  unless the user asks for a different runner or model.
- **Run `build_graph.py` in the foreground** with no timeout. Pi has no background runs or
  Monitor tool, and the user watches the progress lines appear as the command runs. Once it
  ends, relay the lines from step 2 that matter and handle the pause or result.
- **Ask questions in chat.** Wherever it says AskUserQuestion or the question box, write the
  question in your message as a numbered list of options, recommended first and marked
  "(Recommended)", then stop and wait for the reply. One message holds all of a pause's
  questions.
- **Skip what Pi doesn't have:** the cockpit mod (it's never loaded here), push notifications
  and cloud sessions.
- **Write files with the `write` tool**, e.g. the card text in step 2.
- **Never add `--allow-api-billing`.** In Claude Code a hook enforces this; here it's on you.
  Only the user may choose per-token billing.
