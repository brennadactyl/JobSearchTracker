/**
 * The daily search prompt for one track, composed from that track's D1 config
 * (see ../prompt.js) - what run-search.ps1 fetches instead of reading a prompt
 * file off whichever machine it happens to be running on.
 */

import { json, text } from "../http.js";
import { buildSearchPrompt } from "../prompt.js";
import { unknownTrack } from "../validate.js";

/**
 * GET /api/prompt/:key - requires a Bearer token -> text/plain.
 *
 * text/plain because its consumer pipes it straight into the CLI. 409s for a
 * track with `fed_by` set: that tab has no search of its own, and the error
 * names the one to run.
 */
export async function handleGetPrompt({ db, user, params }) {
  const key = params[0];
  const [track, config] = await Promise.all([db.getTrack(key), db.getTracksAndSettings()]);
  if (!track) return unknownTrack(key);

  // A track with `fed_by` set is a tab, not a search: a sibling's run finds
  // its postings and files them here (see migrations/0003_branched_tracks.sql).
  // Composing a prompt for it would produce a second, near-identical search of
  // the same job boards - exactly what the arrangement exists to avoid - so
  // refuse and name the track to run instead. setup-scheduler.ps1 registers no
  // task for one of these, so reaching this is either a hand-run or a
  // scheduled task left over from before the split.
  if (track.fed_by) {
    return json(
      {
        error: `track "${key}" has no search of its own - "${track.fed_by}" fills it. Run that track instead.`,
      },
      409
    );
  }

  // A track that exists but has no search config at all would still compose a
  // perfectly well-formed prompt - out of the generic fallbacks. "Companies:
  // ." and "Read the resume." and no geographic scope, followed by the same
  // instructions to verify postings and POST them as leads. A scheduled run
  // would carry that out and report success.
  //
  // That state is reachable, and not hypothetically: it's exactly what a
  // track looks like between the multi-user migration (which copies no search
  // config) and the config being posted for it. Refuse instead, so the run
  // fails loudly and visibly rather than quietly doing a hollow search.
  if (!track.role_search_line && !track.resume_line && !track.target_companies) {
    return json(
      {
        error: `track "${key}" has no search config yet - post it to /api/config before running this search`,
      },
      409
    );
  }

  // The tabs this run fills besides its own. Passing them turns the prompt
  // multi-tab: dedup for every key, a filing step, and a run record each.
  const feeds = config.tracks.filter((t) => t.fed_by === key);
  // Whether this search rotates through its company list, which is true once
  // it has any coverage rows at all - see buildSearchPrompt.
  const coverage = await db.countCoverage(key);

  return text(buildSearchPrompt({ user, track, settings: config.settings, feeds, coverage }));
}
