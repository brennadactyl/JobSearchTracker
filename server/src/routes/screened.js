/**
 * Screened postings: the ones a search looked at and decided NOT to file as a
 * lead, plus the read a run makes before searching to know what it has already
 * found or already ruled out.
 *
 * The two halves are the same table from opposite ends - one writes the memo,
 * the other is tomorrow's run reading it back.
 */

import { DELISTED_REASON } from "../db.js";
import { excludedCompanyMatcher } from "../exclude.js";
import { json, readJson } from "../http.js";
import { isoDate, unknownTrack, unknownTrackResponse } from "../validate.js";

/**
 * GET /api/dedup/:key - requires a Bearer token.
 *
 * What a scheduled run fetches before searching, to know what it has already
 * found or already ruled out. Deliberately narrow: one track, three columns,
 * and screened as bare urls - see db.getDedupData for why. 404s on an unknown
 * track rather than returning empty arrays, because empty is exactly what a
 * mistyped key would produce, and a run that believes it has seen nothing
 * re-adds every posting it already screened.
 */
export async function handleGetDedup({ db, params }) {
  const key = params[0];
  if (!(await db.trackExists(key))) return unknownTrack(key);
  return json(await db.getDedupData(key));
}

/**
 * POST /api/screened - requires a Bearer token. Body `{ on?, screened: [...] }`
 * -> `{ added, duplicates, excluded }`.
 *
 * Records postings the search looked at and decided NOT to add as a lead
 * (dead-on-arrival, outside the US, wrong level/role-type, duplicate) - see
 * migrations/0001_schema.sql. Same INSERT-OR-IGNORE-on-(search,
 * url) shape as handleAddLeads, but no touchUpdated() call: screened
 * items don't show up on the tracker page, so they shouldn't bump its
 * "last updated" banner.
 *
 * `on` matters: it is the date these rows carry, and /api/runs counts a day's
 * screened rows by it.
 */
export async function handleAddScreened({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const incoming = Array.isArray(body.screened) ? body.screened : [];
  if (incoming.length === 0) return json({ error: "no screened items provided" }, 400);

  const valid = incoming.filter((item) => item.search && item.url);
  if (valid.length === 0) return json({ error: "no valid screened items in payload" }, 400);

  const on = isoDate(body.on);

  // A screened row belongs to the search that did the screening, not to the
  // tab the posting would have been filed under. Those differ for a branched
  // search: one run fills several tabs (`fed_by`, see
  // migrations/0003_branched_tracks.sql), but nothing displays screened rows
  // per-tab and step 1b reads them back as one combined set, so splitting them
  // across the tabs would only add a way to get it wrong.
  //
  // The prompt used to say this in a sentence and rely on the model to do it.
  // Doing it here means the rule holds whether or not that sentence was read,
  // so the sentence is gone - see the note where `screenedNote` used to be
  // built in prompt.js.
  const { tracks, settings } = await db.getTracksAndSettings();

  // Validated against what the caller sent, before the `fed_by` rewrite far
  // below. The rewrite maps a fed key to the track that owns its search, so
  // checking afterwards would report the root's name for a mistake made in
  // the fed tab's name - and the string that drifts is the one in the prompt,
  // which is the one the caller sent. Same all-or-nothing refusal as
  // /api/leads; see unknownTrackResponse for why nothing is inserted.
  const drift = unknownTrackResponse(tracks, valid);
  if (drift) return drift;

  // An excluded company is dropped outright here, and deliberately does NOT
  // become a screened row - which is the opposite of what happens to every
  // other rejected candidate. A screened row is a memo to tomorrow's run
  // saying "this one was considered and ruled out", and the whole point of an
  // exclusion is that it is never considered: it costs a fetch to write, it
  // grows a table that a run reads back every night, and it records a decision
  // that was already permanent. The prompt says this too, and the prompt was
  // not enough - rows 210 and 211 in the live data are Beast Industries,
  // written by a run that verified them first.
  const isExcluded = excludedCompanyMatcher(settings.excluded_companies);
  const allowed = valid.filter((item) => !isExcluded(item.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ added: 0, duplicates: 0, excluded });

  // DELISTED_REASON is the server's own marker, not a phrase a caller may
  // write. countRunActivity splits a day's screened rows on it to tell "a
  // posting we tracked came down" from "a candidate we looked at and
  // rejected", and those are counted into different columns of the run record.
  // A run screening a dead-on-arrival candidate would very reasonably describe
  // it as the posting having been taken down, and that row would then be
  // counted as a delisting of a lead that never existed. Reserving the string
  // here is what keeps the classifier honest without a schema change: the
  // reason is still recorded, just not in the words that mean something else.
  for (const item of allowed) {
    if (typeof item.reason === "string" && item.reason.trim().toLowerCase() === DELISTED_REASON) {
      item.reason = "dead on arrival";
    }
  }

  // One hop, not a walk to a root: a fed track is a tab, and the track that
  // fills it runs its own search, so `fed_by` chains have no meaning in the
  // model (see migrations/0003_branched_tracks.sql) and none exist. Resolving
  // repeatedly would only be guessing at what a chain ought to mean.
  const fedBy = new Map(tracks.map((t) => [t.key, t.fed_by || ""]));
  const filed = allowed.map((item) => ({ ...item, search: fedBy.get(item.search) || item.search }));

  const { added, duplicates } = await db.addScreened(filed, on);
  return json({ added, duplicates, excluded });
}
