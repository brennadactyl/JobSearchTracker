/**
 * Business logic for the Job Search Tracker API worker: parses and
 * validates each request, decides what should happen, and shapes the JSON
 * response. No `env.DB` calls anywhere in this file - all persistence goes
 * through the `db` (a `Db` instance, see ./db.js) each handler receives.
 * That split is the whole point: swapping D1 for a different database only
 * ever means changing db.js, never anything below.
 *
 * This worker is API-only (no page-serving) - the client is a separate
 * deployable (see ../../client/) that calls this API cross-origin, hence
 * CORS_HEADERS below on every response. `*` rather than a specific origin:
 * the session token - not the origin - is the access boundary, and it is
 * never a cookie, so there is nothing here for a hostile origin to ride on
 * the way a cookie-authenticated API would have. Restricting the origin
 * would add config surface (one more per-deployment value to keep in sync
 * with wherever the client is hosted) without adding real security.
 *
 * ---- Auth. A person has a name and a password; they hold bearer tokens
 * (sessions). Passwords are seen by exactly two handlers here - login and
 * user provisioning - and everything else resolves a token to a user before
 * this file is reached; see ./auth.js for the crypto and ../index.js for the
 * resolution. Handlers below never check permissions themselves: they get a
 * `db` already scoped to the calling user (see ./db.js), so "can this person
 * touch this row" is answered by the row not existing for them.
 */

import {
  bearer,
  createSession,
  deleteSession,
  getUserByName,
  upsertUser,
  verifyPassword,
} from "./auth.js";
import { DELISTED_REASON } from "./db.js";
import { excludedCompanyMatcher } from "./exclude.js";
import { buildSearchPrompt } from "./prompt.js";
import { canonicalUrl } from "./url.js";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // charset spelled out: JSON is UTF-8 by definition and browsers assume so,
    // but Windows PowerShell 5.1's Invoke-RestMethod falls back to Latin-1
    // without it. A PowerShell client doing the documented GET-merge-POST on
    // /api/config would then read every em-dash in a prompt setting as
    // mojibake and write it back that way, silently corrupting the config it
    // was only meant to add a field to.
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Valid status values, duplicated from page.html's LEAD_STATUS/APP_STATUS
// (same intentional-duplication pattern as EXTRA_FIELDS in db.js - no build
// step ties client and server together). Used to validate the two
// status-change endpoints below; the generic handleUpdate() path is left
// unvalidated on purpose - see handleSetLeadStatus/handleSetApplicationStatus.
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"];
// "To Apply" is a posting logged before applying to it - a row that lives in
// the Applications tab (so it can carry notes, comp, link, next action) but
// hasn't been sent yet. It's first because it's the stage before "Applied";
// a row that starts here has no dateApplied until it moves on.
export const APP_STATUS = [
  "To Apply", "Applied", "Recruiter Screen", "Tech Screen", "Onsite / Loop",
  "Offer", "Rejected", "Withdrawn",
];

// Which applications column holds the date an application first reached a
// given pipeline stage - mirrors page.html's STAGE_DATE_FIELDS. "Applied"
// maps to dateApplied, the column it already had, so a "To Apply" row gets
// stamped the day it's actually applied to (the stamp only fires on a blank
// column, so it never rewrites a date that's already there).
export const STAGE_DATE_MAP = {
  "Applied": "dateApplied",
  "Recruiter Screen": "dateRecruiterScreen",
  "Tech Screen": "dateTechScreen",
  "Onsite / Loop": "dateOnsite",
  "Offer": "dateOffer",
  "Rejected": "dateRejected",
  "Withdrawn": "dateWithdrawn",
};

// Exchanges a name and password for a session token. The only handler a
// password reaches besides handleUpsertUser, and the only place the name
// means anything - every other route identifies the caller by token alone.
//
// One message for both "no such name" and "wrong password", on purpose: told
// apart, they turn this into a way to enumerate who has an account here.
// `label` is where the caller says what the token is for ('browser', or
// 'scheduled-search' for the long-lived one a headless run keeps on disk), so
// it can be revoked later by what it is rather than by guessing which opaque
// string is which.
export async function handleLogin(request, d1) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || !password) return json({ error: "name and password are required" }, 400);

  const user = await getUserByName(d1, name);
  if (!(await verifyPassword(password, user))) {
    return json({ error: "that name and password don't match" }, 401);
  }

  const token = await createSession(d1, user.id, typeof body.label === "string" ? body.label : "browser");
  return json({ token, user: { id: user.id, name: user.name } });
}

// Revokes exactly the token that made the request - not every session the
// person holds, so logging out of a browser never kills the scheduled search's
// credential. Reaching this handler at all means the token still resolved;
// logging out twice 401s at the routing layer, which is the same answer by a
// different route.
export async function handleLogout(d1, token) {
  await deleteSession(d1, token);
  return json({ ok: true });
}

// Creates a user, or sets an existing one's password. Gated by the ADMIN_TOKEN
// worker secret rather than by a session: there is no self-signup here, and
// whoever operates the deployment provisions people by hand.
//
// It doubles as password reset because nothing else in the system can run
// PBKDF2 - without this, a forgotten password would mean deriving a hash
// offline and hand-writing it into D1.
export async function handleUpsertUser(request, env, d1) {
  const admin = env.ADMIN_TOKEN;
  if (!admin || bearer(request) !== admin) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) return json({ error: "name is required" }, 400);
  // Long rather than complex, and enforced here because /api/login has no rate
  // limiting in front of it - see server/README.md.
  if (password.length < 12) return json({ error: "password must be at least 12 characters" }, 400);

  const result = await upsertUser(d1, name, password);
  return json(result, result.created ? 201 : 200);
}

export function handleGetMe(user) {
  return json({ id: user.id, name: user.name });
}

// Serves the daily search prompt for one track, composed from that track's D1
// config - what run-search.ps1 fetches instead of reading a prompt file off
// the machine it happens to be running on. text/plain because its consumer
// pipes it straight into the CLI.
// What a scheduled run fetches before searching, to know what it has already
// found or already ruled out. Deliberately narrow: one track, three columns,
// and screened as bare urls - see db.getDedupData for why. 404s on an unknown
// track rather than returning empty arrays, because empty is exactly what a
// mistyped key would produce, and a run that believes it has seen nothing
// re-adds every posting it already screened.
export async function handleGetDedup(db, key) {
  if (!(await db.trackExists(key))) {
    return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
  }
  return json(await db.getDedupData(key));
}

// How many companies one run covers. A whole list is more than a run can
// verify properly, and the failure isn't that a company gets missed - it's
// that all of them get skimmed. Twelve is the number that keeps a list the
// size these actually are (35-60) inside a week's cycle while leaving a run's
// budget for what it's for: opening every candidate posting and confirming it
// renders a real job description.
//
// A constant, not config: nobody has wanted a different number, and a setting
// nobody sets is a setting that goes stale. It moves here the day someone does.
export const COVERAGE_BATCH = 12;

// Which companies this run covers, chosen by the server. Least-recently-swept
// first, capped - the run is told what to sweep rather than how to choose,
// because a cap in prose is a cap a run can talk itself out of on a night when
// the list looks short. `?all=1` returns the whole table instead, for seeding
// and for looking at it.
//
// Same 404-on-unknown-track reasoning as the dedup route: an empty list from a
// mistyped key would read as "nothing to sweep", and a run would quietly
// search nothing at all.
export async function handleGetCoverage(db, key, all = false) {
  if (!(await db.trackExists(key))) {
    return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
  }
  const [companies, total] = await Promise.all([
    db.getCoverage(key, all ? 0 : COVERAGE_BATCH),
    db.countCoverage(key),
  ]);
  return json({ companies, total, batch: all ? total : COVERAGE_BATCH });
}

// Records what a run actually attempted. Attempted, not found: a company whose
// board was blocked today still gets stamped, or the rotation retries it every
// run forever and the rest of the list starves.
export async function handleRecordSweeps(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) {
    return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
  }
  const incoming = Array.isArray(body.swept) ? body.swept : [];
  const valid = incoming
    .filter((i) => i && typeof i.company === "string" && i.company.trim())
    .map((i) => ({ ...i, company: i.company.trim() }));
  if (valid.length === 0) return json({ error: "no companies provided" }, 400);

  // Same reasoning as /api/runs: the worker only knows UTC, and a 01:00 local
  // run is already the next UTC day - a date derived here would stamp tomorrow.
  // An explicit "" is not a malformed date, it's "register these companies,
  // I haven't swept them" - the seeding case, which must not stamp anything
  // (see db.recordSweeps).
  const on = typeof body.on === "string" && body.on === ""
    ? ""
    : typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on)
      ? body.on
      : new Date().toISOString().slice(0, 10);

  // The rotation is the surface where an exclusion would become permanent.
  // This route creates a row for any company it is handed - that is how a
  // company broader discovery turned up joins the rotation - so an excluded
  // company swept once would be stored, then handed back by
  // GET /api/coverage as a company to cover, every cycle, forever. Every other
  // exclusion leak is one row; this one is self-renewing.
  const { settings } = await db.getTracksAndSettings();
  const isExcluded = excludedCompanyMatcher(settings.excluded_companies);
  const allowed = valid.filter((i) => !isExcluded(i.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ recorded: 0, excluded, on });

  const recorded = await db.recordSweeps(key, allowed, on);
  return json({ recorded, excluded, on });
}

export async function handleGetPrompt(db, user, key) {
  const [track, config] = await Promise.all([db.getTrack(key), db.getTracksAndSettings()]);
  if (!track) return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);

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

// Records that one track's scheduled search finished - see
// migrations/0001_schema.sql for why this is an explicit call rather than
// something inferred from /api/leads. Called unconditionally at the end
// of every run, including runs that found nothing, since "found nothing" is
// exactly the case the tab can't otherwise distinguish from "didn't run".
//
// Rejects a `search` with no matching track instead of upserting it: an
// unknown key here means the run's track key and the configured tracks have
// drifted apart (a typo in a scheduled-task prompt, or a track renamed in
// config without updating the prompt), and that lead-losing misconfiguration
// is worth surfacing loudly in the run's own output. Silently accepting it
// would create an orphan row that no tab ever displays - the failure mode
// this whole table exists to prevent.
//
// ---- What the caller is trusted for, and what it isn't. `search`, `status`,
// `note` and `on` are things only the run knows. The three counts are not:
// they are arithmetic over rows this database already holds, so they are done
// here (db.countRunActivity) and the caller's own tally is ignored.
//
// The evidence, 2026-09-01: the `SWE` run claimed `leads_added: 97` against a
// tab holding 89 leads, 97 being the combined figure across all four tabs it
// fills - while the three tabs `fed_by` "SWE" had *empty* run records that
// morning, which is the client's "never recorded" state, on a morning one of
// them took 133 leads. The single-tab `CPM` run got all three numbers right.
// Only the multi-tab case failed, because its rule was the longest and
// fiddliest block of prose in the prompt.
//
// Hence the fan-out too: a run record is per track, and asking the run for
// four correctly-split records is precisely what didn't work. One POST in, one
// row per tab out, each counted from its own rows.
//
// The retired count fields are still accepted and ignored, so a run mid-flight
// on a prompt fetched before this deployed still records correctly.
//
// One honest caveat: counting by date means a lead the *user* adds by hand
// today lands in today's run count for that tab. Rare, and still truer than a
// tally computed across four tabs and attributed to one.
export async function handleRecordRun(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) {
    return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);
  }

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
  const on = typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on)
    ? body.on
    : at.slice(0, 10);

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

  // Sequential rather than concurrent, and the posted key first: these are
  // separate writes, not one transaction, so if the worker dies partway the
  // row that survives should be the one whose absence the caller could
  // actually notice and retry. The counts are per key, never shared - that is
  // the bug being fixed, so each tab gets its own count of its own rows.
  const runs = [];
  for (const k of keys) {
    const counts = await db.countRunActivity(k, on);
    runs.push(await db.recordRun(k, { at, on, status, ...counts, note }));
  }

  // `run` stays the posted track's record so existing callers read the same
  // field they always have; `also` is the fed tabs' records, there so a run's
  // own report can say what got written on its behalf rather than having to
  // trust that something did.
  return json({ ok: true, run: runs[0], also: runs.slice(1) });
}

export async function handleGetConfig(db) {
  return json(await db.getTracksAndSettings());
}

// Replaces the whole track list (setup writes the complete desired set at
// once, rather than incrementally patching rows) and/or updates individual
// settings. Existing leads/applications keep their `search` value even if
// its track is later removed here - they just stop having a tab, they're
// never deleted.
export async function handleSetConfig(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

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

export async function handleAddLeads(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  // team/setup/comp are the fields a job posting can actually state (org,
  // remote/hybrid/onsite, a posted salary range); the rest of EXTRA_FIELDS
  // (referral, resume, lastContact, nextAction*, link) are personal/workflow
  // facts the search has no way to know, so they're accepted here (in case a
  // future caller has them) but the scheduled searches never send them -
  // they default to '' and stay for the user to fill in from Details.
  const valid = incoming.filter((lead) => lead.search && lead.url && lead.company && lead.title);
  if (valid.length === 0) return json({ error: "no valid leads in payload" }, 400);

  // The run's own local date, applied to every lead that didn't carry one.
  // Same reasoning as /api/runs' `on`: the worker only knows UTC, so it cannot
  // derive the day the search believes it is having.
  const on = typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on) ? body.on : "";

  // Companies this person will not work for, enforced rather than asked for.
  // The list has been structured config for a while, but the only thing acting
  // on it was a sentence in the prompt, and it leaked: lead 238 in the live
  // data is xAI, which is on the list. A sentence is a request; this is the
  // answer. See ./exclude.js for the matching rules.
  const { settings } = await db.getTracksAndSettings();
  const isExcluded = excludedCompanyMatcher(settings.excluded_companies);
  const allowed = valid.filter((lead) => !isExcluded(lead.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ added: 0, duplicates: 0, excluded });

  const { added, duplicates } = await db.addLeads(allowed, on);
  if (added > 0) await db.touchUpdated();

  // `duplicates` is reported rather than swallowed so a run can say what it
  // actually contributed. Silently returning a smaller `added` than the number
  // of rows posted is how a run comes to believe it found more than it did -
  // and the run summary on the page is built out of exactly these numbers.
  return json({ added, duplicates, excluded });
}

// Records postings the search looked at and decided NOT to add as a lead
// (dead-on-arrival, outside the US, wrong level/role-type, duplicate) - see
// migrations/0001_schema.sql. Same INSERT-OR-IGNORE-on-(search,
// url) shape as handleAddLeads above, but no touchUpdated() call: screened
// items don't show up on the tracker page, so they shouldn't bump its
// "last updated" banner.
export async function handleAddScreened(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.screened) ? body.screened : [];
  if (incoming.length === 0) return json({ error: "no screened items provided" }, 400);

  const valid = incoming.filter((item) => item.search && item.url);
  if (valid.length === 0) return json({ error: "no valid screened items in payload" }, 400);

  const on = typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on) ? body.on : "";

  // A screened row belongs to the search that did the screening, not to the
  // tab the posting would have been filed under. Those differ for a branched
  // search: one run fills several tabs (`fed_by`, see
  // migrations/0003_branched_tracks.sql), but nothing displays screened rows
  // per-tab and step 1b reads them back as one combined set, so splitting them
  // across the tabs would only add a way to get it wrong.
  //
  // The prompt used to say this in a sentence and rely on the model to do it.
  // Doing it here means the rule holds whether or not that sentence was read,
  // and the sentence comes out of the prompt.
  const { tracks, settings } = await db.getTracksAndSettings();

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

  // One hop, not a walk to a root: a fed track is a tab, and the track that
  // fills it runs its own search, so `fed_by` chains have no meaning in the
  // model (see migrations/0003_branched_tracks.sql) and none exist. Resolving
  // repeatedly would only be guessing at what a chain ought to mean.
  const fedBy = new Map(tracks.map((t) => [t.key, t.fed_by || ""]));
  const filed = allowed.map((item) => ({ ...item, search: fedBy.get(item.search) || item.search }));

  const { added, duplicates } = await db.addScreened(filed, on);
  return json({ added, duplicates, excluded });
}

// The two routes below let a run report a *set of URLs* and have the server do
// the lookup, which is the same trade the rest of this file keeps making: the
// run reports what it saw, the server decides what that means. Both of them
// match through here.
//
// Matching is by posting identity (canonicalUrl - see ./url.js), never by raw
// string. That is the entire reason these take URLs at all: a run arrives at a
// posting by whatever link its search handed it, and `?gh_jid=`, a slug, or a
// tracking param make that a different string from the one the lead was filed
// under. String-matched, a run's report of a dead posting would land on nothing
// and the posting would sit on the board looking live.
//
// Several tracked leads can share one canonical key. That isn't hypothetical -
// it is the state url.js was written to describe: one night's run added 8
// duplicate leads before the rule existed, and those rows are still in the
// database. They are the same posting, so a report about it is a report about
// all of them, and every match is returned rather than just the first.
//
// The reported list is deduped by key for the opposite reason: two spellings of
// one posting in one payload are one report, not two, and counting them twice
// would inflate the `delisted` number a run writes to its own record.
//
// ---- These are the first lookups in this codebase keyed by URL rather than by
// row id, and that matters for who can touch what. Every other cross-user
// protection here is a consequence of an id not resolving for the wrong person;
// a URL has no such property, because two people tracking the same posting is a
// supported, deliberate state - UNIQUE is on (user_id, search, url), and
// db.addLeads says so in as many words. So the candidate set this searches is
// db.getLeadsForUrlMatch's, which is `WHERE user_id = ?` like everything else
// in db.js: a URL can only ever resolve to the caller's own rows, and the ids
// that reach db.markVerified and db.deleteLeadAndScreen came from that set (and
// are re-checked against `user_id` by those statements anyway). This function
// never sees another person's leads, so it cannot match one.
//
// An unmatched URL is deliberately reported rather than ignored. It means the
// run believes it is tracking something the tracker has no row for - a lead
// someone deleted by hand, a tab that got reconfigured, or a run working from
// stale dedup data - and that disagreement is worth a line in the run's report.
// The raw URL comes back, not just a count, because a count can't be acted on.
/**
 * @param {Array<{id: number, url: string}>} leads every lead this user tracks
 * @param {string[]} urls the URLs the run reported
 * @returns {{matched: Array<Object>, unmatched: string[]}}
 */
function matchLeadsByUrl(leads, urls) {
  const byKey = new Map();
  for (const lead of leads) {
    const key = canonicalUrl(lead.url);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(lead);
    else byKey.set(key, [lead]);
  }

  const matched = [];
  const unmatched = [];
  const seen = new Set();
  for (const raw of urls) {
    const key = canonicalUrl(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = byKey.get(key);
    if (hit) matched.push(...hit);
    else unmatched.push(raw);
  }
  return { matched, unmatched };
}

// Parses the { search, urls } half both URL-set routes share. Returns a
// Response to hand straight back on any refusal, or the cleaned values.
//
// The unknown-track check is here for the same reason /api/runs has it: a key
// with no configured track means the run's idea of this search and the
// tracker's have drifted apart, and that is worth failing loudly over even
// though neither route below reads the key for anything else (see
// db.getLeadsForUrlMatch on why the match itself spans every tab).
async function parseUrlReport(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: json({ error: "invalid JSON body" }, 400) };
  }
  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return { error: json({ error: "missing search (track key)" }, 400) };
  if (!(await db.trackExists(key))) {
    return { error: json({ error: `unknown track "${key}" - not in the configured tracks` }, 404) };
  }
  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .filter((u) => typeof u === "string" && u.trim())
    .map((u) => u.trim());
  if (urls.length === 0) return { error: json({ error: "no urls provided" }, 400) };
  return { body, key, urls };
}

// Records that a run re-checked the postings it tracks and found these ones
// still live. `verified` has meant "date last verified live" in the schema
// since day one and has never once been written after a lead was created - see
// db.markVerified for the count. This is the call that makes the column true.
//
// `on` falls back to the worker's UTC date if it isn't a YYYY-MM-DD, rather
// than refusing the whole report the way /api/delist does. The asymmetry is
// deliberate and follows the consequences: a wrong date here means a posting
// gets re-checked a day early or late, while a wrong date there permanently
// deletes a real opening. A freshness stamp is not worth failing a run over.
export async function handleMarkVerified(request, db) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = typeof parsed.body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.body.on)
    ? parsed.body.on
    : today();

  const { matched, unmatched } = matchLeadsByUrl(await db.getLeadsForUrlMatch(), parsed.urls);
  const stamped = await db.markVerified(matched.map((l) => l.id), on);
  // The tracker page prints this column as "Confirmed live <date>" on every
  // lead, so a stamp is a change a viewer sees and the "last updated" banner
  // should say so. Only when something actually moved: a report that matched
  // nothing changed nothing.
  if (stamped > 0) await db.touchUpdated();

  return json({ stamped, unmatched: unmatched.length, unmatchedUrls: unmatched, on });
}

export async function handleUpdate(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (body.type === "lead") {
    // `delistedOn` is the one field here the server acts on rather than
    // stores. A scheduled search sending it is reporting a fact it observed -
    // "this posting is gone from the internet" - and what the tracker does
    // about that is a decision this file owns, not the caller's: see
    // removeDelistedLead. Every other key is a plain field write.
    //
    // An empty string is the "found live again" clear, which no longer has
    // anything to undo. It falls through to the normal update path, where the
    // field whitelist ignores it and the lead comes back unchanged - a no-op
    // rather than an error, so a run using the documented call doesn't fail
    // on a posting that came back.
    //
    // Anything else has to be a real YYYY-MM-DD before it acts. What it
    // triggers is a permanent delete and the caller is an LLM: "unknown" or
    // "today" reaching the old code left a bad string in a column, whereas
    // here it would take a live posting off the board for good. A value that
    // isn't a date isn't a report of anything, so it's refused rather than
    // quietly read as "dead, date unknown".
    if (typeof body.delistedOn === "string" && body.delistedOn.trim()) {
      const on = body.delistedOn.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
        return json({ error: "delistedOn must be YYYY-MM-DD" }, 400);
      }
      return removeDelistedLead(db, body.id, on);
    }

    // `search` moves the lead to another of this user's tabs. It's the one
    // field here that can fail on its own terms, so both failures are caught
    // rather than left to surface as a 500: an unknown track key is the same
    // drift /api/runs rejects (a lead filed under a key no tab displays is a
    // lead nobody sees again), and the destination may already hold this url,
    // which UNIQUE(user_id, search, url) refuses.
    const move = typeof body.search === "string" && body.search ? body.search : "";
    if (move && !(await db.trackExists(move))) {
      return json({ error: `unknown track "${move}" - not in the configured tracks` }, 404);
    }
    let lead;
    try {
      lead = await db.updateLead(body.id, body);
    } catch (err) {
      if (move && /UNIQUE|constraint/i.test(String((err && err.message) || ""))) {
        return json({ error: `"${move}" already has a lead for that url` }, 409);
      }
      throw err;
    }
    if (!lead) return json({ error: "lead not found" }, 404);
    await db.touchUpdated();
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    if (body.id) {
      const app = await db.updateApplication(body.id, body);
      if (!app) return json({ error: "application not found" }, 404);
      await db.touchUpdated();
      return json({ ok: true, application: app });
    } else {
      const app = await db.insertApplication(body);
      await db.touchUpdated();
      return json({ ok: true, application: app });
    }
  }

  return json({ error: "unknown update type" }, 400);
}

// Atomically moves a lead to "Applied" and creates its application row -
// replaces the client's old two-sequential-POST approach (set status, then
// a separate call to create the application), which could leave a lead
// marked Applied with no application if the second call never landed.
// db.setLeadStatusAndMaybeCreateApplication runs both writes as one real
// D1 transaction: if either statement fails, both roll back.
//
// The duplicate-application guard here is a read-then-conditionally-write
// within one request, not a schema-enforced constraint - it doesn't
// protect against two genuinely concurrent requests for the same lead
// (e.g. two devices). Still a strict improvement over the previous
// client-side guard, which trusted stale local state and never
// re-checked the server at all.
export async function handleSetLeadStatus(request, db, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!LEAD_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }

  const [lead, existingApp] = await Promise.all([db.getLead(id), db.getApplicationByLeadId(id)]);
  if (!lead) return json({ error: "lead not found" }, 404);

  const willCreateApp = body.status === "Applied" && !existingApp;
  const { lead: updatedLead, application: newApp } = await db.setLeadStatusAndMaybeCreateApplication(
    id,
    body.status,
    willCreateApp
      ? {
          leadId: String(id),
          company: lead.company,
          title: lead.title,
          dateApplied: today(),
          status: "Applied",
          notes: lead.notes || "",
          link: lead.url || "",
          referral: lead.referral || "",
          comp: lead.comp || "",
          team: lead.team || "",
          setup: lead.setup || "",
        }
      : null
  );
  await db.touchUpdated();

  return json({ lead: updatedLead, application: willCreateApp ? newApp : existingApp || null });
}

// Validates status and, the first time an application reaches a stage
// with a Stage history column (STAGE_DATE_MAP), stamps it with a date in
// the same statement - but only if that column is still empty, so it
// never overwrites a date the user corrected or backfilled by hand (that
// still goes through the generic handleUpdate() path above). The date
// stamped is body.date when the client sends one - the tracker page
// prompts for it whenever a status change is about to stamp a blank
// column, since "today" is often wrong (the stage happened a few days
// before it's getting logged) - falling back to today() if it's missing
// or malformed, same as before this existed.
//
// Moving back to "To Apply" is the one case that clears a date instead of
// stamping one: the row is being marked as not applied to yet, so the
// applied date it was created with (insertApplication defaults it to today)
// would be a lie, and leaving it there would also block the stamp above
// from firing when the application actually goes out.
export async function handleSetApplicationStatus(request, db, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!APP_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }
  const explicitDate = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;

  const application = await db.setApplicationStatus(
    id,
    body.status,
    STAGE_DATE_MAP[body.status] || null,
    body.status === "To Apply" ? "dateApplied" : null,
    explicitDate
  );
  if (!application) return json({ error: "application not found" }, 404);
  await db.touchUpdated();
  return json({ application });
}

export async function handleDeleteApplication(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.id) return json({ error: "missing id" }, 400);
  const deleted = await db.deleteApplication(body.id);
  if (!deleted) return json({ error: "application not found" }, 404);
  await db.touchUpdated();
  return json({ ok: true });
}

/**
 * What the tracker does when a search reports that a posting it tracks has
 * been taken down. The rule, in one place, in code:
 *
 *   - a lead an application row points at is kept, untouched;
 *   - any other lead is deleted, and its URL recorded as screened.
 *
 * Deleting is the point: a dead posting is nothing anyone can act on, and a
 * lead's whole reason to sit in a search tab is that it can be applied to.
 * Recording the URL as screened is what keeps that from undoing itself -
 * without it tomorrow's run rediscovers the URL, finds nothing tracking it,
 * and adds it straight back as a new lead. Both happen in one transaction
 * (see db.js's deleteLeadAndScreen).
 *
 * The applied-to exception is the one case where the posting's fate stops
 * mattering: an application row points at that lead's id, and from the moment
 * it exists what's being tracked is the application, not whether the listing
 * outlived it. That lead is kept and the report is simply absorbed - there's
 * no "delisted" state left to write it into, and nothing on the page would
 * show one. The test for it is the application row itself rather than the
 * lead's status: "Applied" is how one normally gets there, but a lead can
 * carry an application while sitting in another status - nothing deletes the
 * application when a lead moves back out of "Applied", and handleUpdate
 * writes `status` without validating it - and deleting that lead would strand
 * the row pointing at its id.
 *
 * Deliberately not the caller's decision. The caller is a nightly LLM run
 * following a prompt, and a policy written into a prompt is a policy that
 * drifts, can't be tested, and has to be re-deployed by re-wording English.
 * The run's job is to report what it saw; this is where what that means gets
 * decided, and it changes for every existing search the moment it's deployed.
 *
 * ---- Why this takes a lead rather than an id, and returns a verdict rather
 * than a Response. There are two ways in now: one lead by id (the client's
 * /api/update `delistedOn` field, and any in-flight run still using it) and a
 * whole set of URLs at once (/api/delist). Both have to apply the same rule,
 * and the way that goes wrong is not that someone rewrites the rule wholesale -
 * it's that one entry point gets a fix the other doesn't and the two quietly
 * disagree about, say, whether a lead carrying an application is safe. So the
 * rule lives here, once, and the entry points below are reduced to fetching
 * leads and shaping JSON. Duplicating it is the exact failure this whole line
 * of work exists to prevent.
 *
 * @param {Db} db
 * @param {Object} lead - the already-fetched lead row, so this doesn't re-read it
 * @param {string} on - the date the run confirmed it dead (its own local date, already validated as YYYY-MM-DD by the caller)
 * @returns {Promise<{kept: boolean, removed: boolean}>} `kept` is the applied-to
 *   exception; `removed` is what the DELETE actually matched
 */
async function delistLead(db, lead, on) {
  if (lead.status === "Applied" || (await db.getApplicationByLeadId(lead.id))) {
    return { kept: true, removed: false };
  }

  // `on` is the run's own local date, not the worker's UTC one - same
  // reasoning as /api/runs' `on`, and here it's the only surviving record of
  // when the posting died, since the lead row itself is about to be gone.
  //
  // `removed` is what the DELETE actually matched, not what was intended: two
  // runs reporting the same lead at once both get past the read above, and the
  // second one deletes nothing. Saying so keeps a caller's own summary honest.
  // It no longer feeds the tracker's `delisted` count - countRunActivity
  // derives that from the screened rows a delisting leaves behind, precisely so
  // it doesn't depend on a caller adding these up correctly.
  const removed = await db.deleteLeadAndScreen(lead, DELISTED_REASON, on);
  return { kept: false, removed };
}

// The by-id entry point: POST /api/update with a `delistedOn` date. The client
// uses it, and a nightly run may still be part-way through a night on the old
// wording, so it keeps working and keeps its exact response shape.
async function removeDelistedLead(db, id, on) {
  const lead = await db.getLead(id);
  if (!lead) return json({ error: "lead not found" }, 404);

  const { kept, removed } = await delistLead(db, lead, on);
  if (kept) return json({ ok: true, lead, removed: false, reason: "applied to - kept" });

  await db.touchUpdated();
  return json({ ok: true, removed, id: lead.id, screened: lead.url });
}

// The by-URL entry point: one call reporting every posting a run confirmed dead
// tonight. It replaces a run carrying lead ids from step 1b all the way to step
// 8, issuing one curl per dead lead, and tallying `removed:true` against
// `removed:false` itself - bookkeeping the server can do exactly and a model
// can only do approximately.
//
// `on` must be a real YYYY-MM-DD or the whole call is refused, same as the
// by-id path and for the same reason: what this triggers is a permanent delete,
// the caller is an LLM, and "unknown" or "today" is not a report of anything.
// Refused for the batch as a whole rather than per URL, because a date that
// isn't a date says the run doesn't know what day it is, which is not a thing
// to act on partially.
//
// The leads are delisted one at a time rather than in parallel: each one is
// already a two-statement transaction (db.deleteLeadAndScreen), and a night
// where a hundred postings came down should not turn into a hundred concurrent
// transactions against the same table to save a few hundred milliseconds on a
// scheduled job nobody is waiting on.
export async function handleDelistUrls(request, db) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = typeof parsed.body.on === "string" ? parsed.body.on.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return json({ error: "on must be YYYY-MM-DD" }, 400);

  const { matched, unmatched } = matchLeadsByUrl(await db.getLeadsForUrlMatch(), parsed.urls);

  let removed = 0;
  let kept = 0;
  for (const lead of matched) {
    const verdict = await delistLead(db, lead, on);
    if (verdict.kept) kept++;
    else if (verdict.removed) removed++;
    // Neither, when the DELETE matched nothing - the concurrent-report race
    // delistLead describes. Counted as neither on purpose: the lead is gone,
    // but this call is not what removed it, and `removed` is what the run
    // reports as its `delisted` count.
  }
  if (removed > 0) await db.touchUpdated();

  return json({ removed, kept, unmatched: unmatched.length, unmatchedUrls: unmatched, on });
}

export async function handleGetData(db, user) {
  const [leads, applications, screened, updated, config] = await Promise.all([
    db.getAllLeads(),
    db.getAllApplications(),
    db.getAllScreened(),
    db.getUpdatedTimestamp(),
    db.getTracksAndSettings(),
  ]);
  return json({
    // Who the token resolved to, so the page can say whose search it's
    // showing. The client never decides this - it has no way to ask for
    // someone else's data, since every row above is already scoped to the
    // session that made the request.
    user: { id: user.id, name: user.name },
    updated,
    leads,
    applications,
    screened,
    tracks: config.tracks,
    settings: config.settings,
  });
}
