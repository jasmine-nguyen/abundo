// Pi extension for the build's Pi runner: every tool call goes past build_guard.py first,
// so a Pi helper is held to the same rules as a Claude one.
import { spawnSync } from "node:child_process";

export default function (pi: any) {
  const { BUILD_GUARD_POLICY: policy, BUILD_GUARD_ROOT: root, BUILD_GUARD_PYTHON: python } = process.env;

  pi.on("tool_call", async (event: any) => {
    if (!policy || !root || !python) return { block: true, reason: "The build guard isn't set up." };
    const check = spawnSync(python, [`${root}/build_guard.py`, policy, root], {
      input: JSON.stringify({ toolName: event.toolName, input: event.input }),
      encoding: "utf8",
    });
    if (check.status !== 0) return { block: true, reason: `The build guard failed: ${check.stderr}` };
    const reason = check.stdout.trim();
    if (reason) return { block: true, reason };
  });
}
