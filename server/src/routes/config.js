/**
 * This person's configuration: which track tabs exist, what they're labelled,
 * and the prose settings ../prompt.js composes each track's daily search
 * prompt from. The client renders off this rather than a baked-in TRACKS
 * object, which is what lets one deployment hold several people's searches.
 */

import { json, readJson } from "../http.js";

/**
 * GET /api/config - requires a Bearer token -> `{ tracks[], settings }`.
 *
 * Track tabs, tab labels, display title, priority-location rules and the
 * staleness threshold, plus each track's search config and the prose settings.
 * Each track carries its own `last_run`.
 */
export async function handleGetConfig({ db }) {
  return json(await db.getTracksAndSettings());
}

/**
 * POST /api/config - requires a Bearer token. Body `{ tracks?, display_title?,
 * overview_label?, applications_label?, stale_run_hours?, priority_locations?,
 * geo_scope_line?, scope_clause?, scope_disqualifier?, location_guidance?,
 * footer_note?, pronouns? }`.
 *
 * Replaces the whole track list (setup writes the complete desired set at
 * once, rather than incrementally patching rows) and/or updates individual
 * settings. Existing leads/applications keep their `search` value even if
 * its track is later removed here - they just stop having a tab, they're
 * never deleted. Writing `tracks` also keeps search_runs 1:1 with it - new
 * tracks gain a "never ran" row, removed tracks lose theirs.
 */
export async function handleSetConfig({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (Array.isArray(body.tracks)) {
    const valid = body.tracks.filter((t) => t && typeof t.key === "string" && t.key);
    if (valid.length === 0) return json({ error: "tracks must be a non-empty array of {key, ...}" }, 400);
    // A `fed_by` pointing anywhere but at another track in this same list is a
    // tab no search fills: nothing lands in it and nothing records a run
    // against it, so it sits there reading "no run recorded yet" forever with
    // no error anywhere to say why.
    const keys = new Set(valid.map((t) => t.key));
    for (const t of valid) {
      if (t.fed_by && (t.fed_by === t.key || !keys.has(t.fed_by))) {
        return json({ error: `track "${t.key}" is fed_by "${t.fed_by}", which is not another track in this list` }, 400);
      }
    }
    // Each track carries its display fields and, optionally, its search
    // config (TRACK_CONFIG_FIELDS in db.js - the role line, target companies,
    // candidate blurb and so on that prompt.js composes the daily prompt
    // from). replaceTracks whitelists them itself; anything absent is stored
    // as '' and simply doesn't appear in the prompt.
    await db.replaceTracks(valid);
  }

  // display_title, overview_label, applications_label, stale_run_hours,
  // priority_locations, plus the prompt-only prose settings
  // (PROMPT_SETTING_KEYS in db.js). db.setSettings reads only the keys it
  // cares about, so it's a safe no-op to call even when `body` had none of
  // them (e.g. a tracks-only config post).
  if (body.stale_run_hours != null) {
    const n = Number(body.stale_run_hours);
    if (!Number.isFinite(n) || n <= 0) return json({ error: "stale_run_hours must be a positive number" }, 400);
  }
  await db.setSettings(body);

  return json(await db.getTracksAndSettings());
}
