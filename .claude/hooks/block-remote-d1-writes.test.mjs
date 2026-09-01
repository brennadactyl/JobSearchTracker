// Feeds each case through the hook the way Claude Code does (JSON on stdin)
// and reports allow/deny. Cases live in a file so this script's own command
// line doesn't contain the trigger strings.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HOOK = "C:/VibeCoding/.claude/hooks/block-remote-d1-writes.mjs";
const cases = JSON.parse(readFileSync(new URL("./hook-cases.json", import.meta.url), "utf8"));

for (const [command, label] of cases) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  const denied = (r.stdout || "").includes('"deny"');
  console.log(`  ${denied ? "DENIED " : "allowed"}  ${label}`);
}
