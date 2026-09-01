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

/**
 * Commands that destroy the deployment itself rather than write to it, each
 * refused outright with no read-only variant to allow.
 *
 * `d1 delete` is the important one: it takes the database AND its Time Travel
 * history in a single step, which is the one scenario point-in-time recovery
 * cannot save you from - the recovery mechanism lives inside the thing being
 * deleted. `time-travel restore` is destructive and whole-database, so with
 * more than one person on the deployment it rolls back everyone. Deleting the
 * Worker doesn't touch data but takes the tracker offline.
 *
 * None of these should ever be an agent's idea. A human can still run them in
 * their own terminal; this only binds tool calls.
 */
// Match an actual wrangler *invocation* - start of the command, or after a
// shell operator - not the words appearing somewhere in an argument. Without
// this the hook refuses a `git commit` whose message merely discusses these
// commands, which it did on the first attempt.
const INVOKE = String.raw`(?:^|[;&|(\n]\s*)(?:npx\s+(?:--[\w-]+\s+)*)?wrangler\s+`;
const invoking = (tail) => new RegExp(INVOKE + tail, "i");

const DESTRUCTIVE = [
  {
    re: invoking(String.raw`d1\s+delete\b`),
    what: "deletes the D1 database outright - and its Time Travel history with it, which is the one loss point-in-time recovery cannot undo",
  },
  {
    re: invoking(String.raw`d1\s+time-travel\s+restore\b`),
    what: "rolls the whole database back in place, discarding everything written since that point - for every user on the deployment, not just one",
  },
  {
    re: invoking(String.raw`delete\b`),
    what: "deletes the deployed Worker, taking the tracker offline",
  },
];

/**
 * Paths that must not be deleted by a tool call, and the delete verbs to
 * watch for.
 *
 * The backups are the only copy of the tracker's data that survives the
 * Cloudflare account itself - Time Travel lives inside the account it
 * protects, so a local export is the whole of the off-account story. A guard
 * that stops an agent wiping the database but leaves it free to `rm` the
 * exports protects nothing.
 *
 * The hook directory is here too, so the guard can't be removed by the thing
 * it guards against. That is a speed bump, not a wall - see the honesty note
 * at the bottom of this file.
 *
 * Verbs are matched at an invocation boundary, same as the wrangler rules, so
 * a command that merely mentions a path isn't refused.
 */
const PROTECTED = /(?:private[\\/]+backups|[a-z]:[\\/]+vibecoding[\\/]+private(?![\w-])|\.claude[\\/]+hooks)/i;
// No `|` in the boundary set, unlike the wrangler rules: a pipe appears inside
// regex literals and quoted strings far more often than it precedes a delete,
// and `|rm ` in someone's regex was enough to refuse an innocent command. A
// piped `... | xargs rm` slips through as a result - accepted, because the
// filesystem permissions are the real control and this is the reminder.
const DELETE_VERB =
  /(?:^|[;&(\n]\s*)(?:sudo\s+)?(?:rm|rmdir|unlink|del|erase|rd|remove-item|ri|clear-content|move-item|mv)\b/i;

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

  // Deleting the local backups, or the guard itself.
  if (DELETE_VERB.test(command) && PROTECTED.test(command)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Refused: this deletes (or moves) local backups or the hook guarding them. Those " +
            "exports are the only copy of the tracker's data that survives losing the Cloudflare " +
            "account - Time Travel lives inside the account it protects. Pruning old backups is a " +
            "reasonable thing to want, but it's the person's call, not an agent's: say which files " +
            "and let them run it.",
        },
      })
    );
    process.exit(0);
  }

  // Destruction first: these have no allowed variant, so there's nothing to
  // check for --local or a read-only shape.
  for (const { re, what } of DESTRUCTIVE) {
    if (!re.test(command)) continue;
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Refused: this ${what}. Not an agent's call to make. If it genuinely needs doing, ` +
            `say so and let the person run it themselves - and take a \`wrangler d1 export\` first, ` +
            `since that file is the only copy that survives the database being deleted.`,
        },
      })
    );
    process.exit(0);
  }

  const isD1Execute = invoking(String.raw`d1\s+execute\b`).test(command);
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
