/**
 * The record that one track's scheduled search finished - see
 * ../../migrations/0001_schema.sql for why this is an explicit call rather
 * than something inferred from /api/leads.
 */

import { json, readJson } from "../http.js";
import { isoDate, unknownTrack } from "../validate.js";

/**
 * POST /api/runs - requires a Bearer token. Body
 * `{ search, status?, note?, at?, on? }` -> `{ ok, run, also }`.
 *
 * Called unconditionally at the end of every run, including runs that found
 * nothing, since "found nothing" is exactly the case the tab can't otherwise
 * distinguish from "didn't run".
 *
 * Rejects a `search` with no matching track instead of upserting it: an
 * unknown key here means the run's track key and the configured tracks have
 * drifted apart (a typo in a scheduled-task prompt, or a track renamed in
 * config without updating the prompt), and that lead-losing misconfiguration
 * is worth surfacing loudly in the run's own output. Silently accepting it
 * would create an orphan row that no tab ever displays - the failure mode
 * this whole table exists to prevent.
 *
 * ---- What the caller is trusted for, and what it isn't. `search`, `status`,
 * `note` and `on` are things only the run knows. The three counts are not:
 * they are arithmetic over rows this database already holds, so they are done
 * here (db.countRunActivity) and the caller's own tally is ignored.
 *
 * The evidence, 2026-09-01: the `SWE` run claimed `leads_added: 97` against a
 * tab holding 89 leads, 97 being the combined figure across all four tabs it
 * fills - while the three tabs `fed_by` "SWE" had *empty* run records that
 * morning, which is the client's "never recorded" state, on a morning one of
 * them took 133 leads. The single-tab `CPM` run got all three numbers right.
 * Only the multi-tab case failed, because its rule was the longest and
 * fiddliest block of prose in the prompt.
 *
 * Hence the fan-out too: a run record is per track, and asking the run for
 * four correctly-split records is precisely what didn't work. One POST in, one
 * row per tab out, each counted from its own rows.
 *
 * The retired count fields are still accepted and ignored, so a run mid-flight
 * on a prompt fetched before this deployed still records correctly.
 *
 * One honest caveat: counting by date means a lead the *user* adds by hand
 * today lands in today's run count for that tab. Rare, and still truer than a
 * tally computed across four tabs and attributed to one.
 */
export async function handleRecordRun({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) return unknownTrack(key);

  const now = new Date();
  // `at` is an instant the server can trust; a caller-supplied one is only
  // honoured if it parses, so a malformed clientside date can't poison the
  // staleness math into reading "ran in 2087" and never warning again.
  let at = now.toISOString();
  if (typeof body.at === "string" && body.at && !isNaN(Date.parse(body.at))) {
    at = new Date(body.at).toISOString();
  }
  // `on` is the caller's *local* date - the worker can't derive it (see the
  // note in migrations/0001_schema.sql). Falls back to the UTC date, which is right for
  // any run scheduled outside the hours where the two disagree.
  const on = isoDate(body.on) || at.slice(0, 10);

  const status = body.status === "error" ? "error" : "ok";
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";

  // Every tab this one run fills: the posted track, then the tracks whose
  // `fed_by` names it. Read through getTracksAndSettings rather than a
  // purpose-built query because that is exactly how handleGetPrompt decides
  // which tabs to write the prompt for - the run and its record should be
  // agreeing about the same set from the same source, not from two lookups
  // that could one day disagree about what feeds what.
  const config = await db.getTracksAndSettings();
  const keys = [key, ...config.tracks.filter((t) => t.fed_by === key).map((t) => t.key)];

  // Count every tab first, then write them all in one transaction. Both
  // halves matter. The counts are per key and never shared - that is the bug
  // being fixed, so each tab gets its own count of its own rows - and the
  // writes are all-or-nothing, because a fan-out that can half-succeed
  // re-creates the very state this is here to prevent: a tab that was
  // searched last night reading as never having run, with the run that could
  // have retried already over.
  const counted = await Promise.all(
    keys.map(async (k) => ({ key: k, at, on, status, note, ...(await db.countRunActivity(k, on)) }))
  );
  const runs = await db.recordRuns(counted);

  // `run` stays the posted track's record so existing callers read the same
  // field they always have; `also` is the fed tabs' records, there so a run's
  // own report can say what got written on its behalf rather than having to
  // trust that something did.
  return json({ ok: true, run: runs[0], also: runs.slice(1) });
}
