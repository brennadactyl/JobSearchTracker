/**
 * PreToolUse hook: refuse direct writes to the deployed D1 database.
 *
 * The tracker's data has exactly one supported write path - its HTTP API,
 * which scopes every statement to the calling user and validates what it is
 * given. A `wrangler d1 execute --remote` that INSERTs or UPDATEs bypasses
 * all of that, and it is what an agent reaches for when an API route turns
 * out not to support the field it wants. That happened on 2026-08-31: a
 * headless backfill found `/api/update` couldn't set `fit`, and wrote 131
 * UPDATE statements straight to production instead of stopping to report it.
 * The result was fine; the habit is not.
 *
 * Deliberately still allowed:
 *   - anything with --local (a throwaway database)
 *   - read-only --remote queries (SELECT, pragma inspection, counts)
 *   - `wrangler d1 migrations apply` - schema changes have their own
 *     reviewed, versioned path and are not what this is guarding
 *   - `wrangler d1 export` - backups
 *
 * Applies to Claude Code tool calls only; a human running wrangler in their
 * own terminal is unaffected.
 */
const WRITE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|VACUUM|ATTACH)\b/i;

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let command = "";
  try {
    const payload = JSON.parse(input);
    command = (payload.tool_input && payload.tool_input.command) || "";
  } catch {
    process.exit(0); // Unparseable payload is not this hook's problem.
  }

  const isD1Execute = /wrangler[\s\S]{0,80}?\bd1\b[\s\S]{0,80}?\bexecute\b/i.test(command);
  const isRemote = /--remote\b/.test(command);
  if (!isD1Execute || !isRemote) process.exit(0);

  // A --file payload can't be judged from the command line, so treat it as a
  // write: the whole point of passing a file is running statements.
  const viaFile = /--file[= ]/.test(command);
  if (!WRITE.test(command) && !viaFile) process.exit(0);

  const reason = viaFile
    ? "This runs a SQL file against the deployed D1 database, bypassing the API."
    : "This writes directly to the deployed D1 database, bypassing the API.";

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `${reason} The tracker's only supported write path is its HTTP API, which ` +
          `scopes every statement to one user and validates the input; a raw UPDATE does ` +
          `neither. If the API has no route for what you need, stop and say so rather than ` +
          `going around it - that gap is the thing worth reporting. Reads (SELECT), ` +
          `--local, migrations apply, and export are all still allowed.`,
      },
    })
  );
  process.exit(0);
});
