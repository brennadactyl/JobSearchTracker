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
import { buildSearchPrompt } from "./prompt.js";

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

  return text(buildSearchPrompt({ user, track, settings: config.settings, feeds }));
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

  const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  const status = body.status === "error" ? "error" : "ok";

  const run = await db.recordRun(key, {
    at,
    on,
    status,
    leadsAdded: count(body.leadsAdded),
    screenedAdded: count(body.screenedAdded),
    delisted: count(body.delisted),
    note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
  });

  return json({ ok: true, run });
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
    // `fed_by` has to name another track in this same list, and that track has
    // to be one that actually runs. A tab fed by a key that doesn't exist (or
    // by another fed tab) is a tab no search fills: nothing would ever land in
    // it and nothing would record a run against it, so it would sit there
    // permanently reading "no run recorded yet" with no error anywhere to say
    // why. Cheaper to refuse the post.
    //
    // Checked against the *merged* value, not the posted one: replaceTracks
    // keeps a field the payload doesn't mention, so a later post that renames a
    // tab (`{key, label}`) and drops the feeding track from the list would
    // otherwise slip a now-dangling fed_by through unexamined.
    const stored = {};
    for (const t of (await db.getTracksAndSettings()).tracks) stored[t.key] = t;
    const fedByOf = (t) =>
      typeof t.fed_by === "string" ? t.fed_by : (stored[t.key] && stored[t.key].fed_by) || "";
    const byKey = new Map(valid.map((t) => [t.key, t]));
    for (const t of valid) {
      const fedBy = fedByOf(t);
      if (!fedBy) continue;
      if (fedBy === t.key) return json({ error: `track "${t.key}" cannot feed itself` }, 400);
      const feeder = byKey.get(fedBy);
      if (!feeder) {
        return json({ error: `track "${t.key}" is fed_by "${fedBy}", which is not in this track list` }, 400);
      }
      if (fedByOf(feeder)) {
        return json({ error: `track "${t.key}" is fed_by "${fedBy}", which is itself fed by another track` }, 400);
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

  const added = await db.addLeads(valid);
  if (added > 0) await db.touchUpdated();

  return json({ added });
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

  const added = await db.addScreened(valid);
  return json({ added });
}

export async function handleUpdate(request, db) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (body.type === "lead") {
    // delistedOn is set/cleared by the scheduled searches (see
    // migrations/0001_schema.sql) - kept separate from `status`
    // so it never overwrites the installer's own application-progress field.
    //
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
