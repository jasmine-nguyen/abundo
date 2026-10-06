---
name: simulator-check
description: Check an iOS app's screens in the iOS Simulator with AXe — preflight (right build running), proof for each check, and when to hand a check back as manual. Use when the project has an iOS app (an `ios/` folder, or `expo.ios` in `app.json`) and a change's screens need checking.
---

# Simulator check

Drive the iOS Simulator with AXe (taps, swipes, typing, screenshots, the
accessibility tree) to run screen and navigation checks yourself instead of
listing them for the user.

## Commands

Read `axe init --print` for AXe's commands: it is AXe's own guide and always
matches the installed version. Find `--label` / `--id` selectors with
`axe describe-ui --udid <UDID>` and prefer them to coordinates.

Not installed? `brew install cameroncooke/axe/axe`. Ask the user first; never
install it in an unattended run.

## Preflight

Stop at the first failure you may not fix below and leave the check manual,
saying why. Never install tools, or build or install the app.

1. AXe is installed: `command -v axe`.
2. Exactly one simulator is booted: `xcrun simctl list devices booted`. Use its UDID.
   None booted?
   - Interactive session: boot the iPhone that has the app installed (step 3's
     check, run per device from `xcrun simctl list devices available`):
     `xcrun simctl boot <UDID>`, then `open -a Simulator`. Tell the user.
   - Unattended (the build's QA): stop. Never boot a simulator unattended.
3. The app is installed. Read the bundle id from `app.json`
   (`expo.ios.bundleIdentifier`), then
   `xcrun simctl get_app_container <UDID> <bundle id>`.
4. The simulator runs the build under test:
   - No native change: `git diff --name-only $(git merge-base HEAD origin/main) HEAD`
     lists no file under `ios/` and no change to `app.json`, `package.json`
     native deps or `Podfile*`. Otherwise the installed app is old, so stop.
   - Metro is running: `lsof -ti tcp:8081`. Not running?
     - Interactive session: start it from your own folder in the background
       (the project's `start` script, e.g. `npm start`), wait until
       `lsof -ti tcp:8081` answers, and tell the user.
     - Unattended (the build's QA): stop.
   - Find Metro's folder: `lsof -a -d cwd -p <pid>`.
   - `git -C <that folder> rev-parse HEAD` equals your own `git rev-parse HEAD`.
   - `git -C <that folder> status --porcelain` shows no app-code edits.
5. Relaunch so the current bundle loads:
   `xcrun simctl terminate <UDID> <bundle id>`, then
   `xcrun simctl launch <UDID> <bundle id>`.

## Don't disrupt the user

- Interactive session: ask before driving a simulator or Metro that was already
  running, since the user may be using it, and never stop their Metro. One you
  booted or started yourself needs no asking.
- Unattended (the build's QA): only when the preflight passes, and say in your
  output that you used the simulator.

## Proof for each check

- Screenshot: `axe screenshot --udid <UDID> --output /tmp/<card>-<screen>.png`,
  then Read the image.
- Re-run `axe describe-ui --udid <UDID>` and confirm the expected text or element.
- A check passes only when both agree.

## Still manual

- Visual judgement (colour, spacing, feel).
- Real external data, real devices.
- Anything the preflight blocked.

## Example: every tab opens

For each tab-bar label from `describe-ui`: tap it by label, take a screenshot
and Read it, then `describe-ui` again to confirm the tab's title or a known
element is on screen.
