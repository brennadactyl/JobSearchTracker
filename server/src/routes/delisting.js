/**
 * The two reports a nightly run makes about the postings it already tracks:
 * which are still live (/api/verified), and which have come down (/api/delist).
 * Plus the rule for what "come down" means, which /api/update's by-id path
 * (see ./update.js) shares rather than restates.
 *
 * Both routes let a run report a *set of URLs* and have the server do the
 * lookup, which is the same trade the rest of this codebase keeps making: the
 * run reports what it saw, the server decides what that means.
 *
 * Matching is by posting identity (canonicalUrl - see ../url.js), never by raw
 * string. That is the entire reason these take URLs at all: a run arrives at a
 * posting by whatever link its search handed it, and `?gh_jid=`, a slug, or a
 * tracking param make that a different string from the one the lead was filed
 * under. String-matched, a run's report of a dead posting would land on nothing
 * and the posting would sit on the board looking live.
 *
 * Several tracked leads can share one canonical key. That isn't hypothetical -
 * it is the state url.js was written to describe: one night's run added 8
 * duplicate leads before the rule existed, and those rows are still in the
 * database. They are the same posting, so a report about it is a report about
 * all of them, and every match is returned rather than just the first.
 *
 * The reported list is deduped by key for the opposite reason: two spellings of
 * one posting in one payload are one report, not two. The run record's counts
 * no longer come from here - the tracker derives them from the rows - but
 * `removed` and `stamped` are what the run states in its own summary to the
 * person reading it, and a posting counted twice there is just as wrong.
 */

import { DELISTED_REASON } from "../db.js";
import { json, readJson } from "../http.js";
import { canonicalUrl } from "../url.js";
import { isoDate, today, unknownTrack } from "../validate.js";

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
  const body = await readJson(request);
  if (body instanceof Response) return { error: body };

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return { error: json({ error: "missing search (track key)" }, 400) };
  if (!(await db.trackExists(key))) return { error: unknownTrack(key) };

  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .filter((u) => typeof u === "string" && u.trim())
    .map((u) => u.trim());
  if (urls.length === 0) return { error: json({ error: "no urls provided" }, 400) };
  return { body, key, urls };
}

/**
 * POST /api/verified - requires a Bearer token. Body `{ search, on?,
 * urls: [...] }` -> `{ stamped, unmatched, unmatchedUrls, on }`.
 *
 * Records that a run re-checked the postings it tracks and found these ones
 * still live. `verified` has meant "date last verified live" in the schema
 * since day one and has never once been written after a lead was created - see
 * db.markVerified for the count. This is the call that makes the column true.
 * Since delisting deletes (migrations/0004), a lead still in a tab is presumed
 * live, and this is the only signal of how stale that presumption is.
 *
 * `on` falls back to the worker's UTC date if it isn't a YYYY-MM-DD, rather
 * than refusing the whole report the way /api/delist does. The asymmetry is
 * deliberate and follows the consequences: a wrong date here means a posting
 * gets re-checked a day early or late, while a wrong date there permanently
 * deletes a real opening. A freshness stamp is not worth failing a run over.
 */
export async function handleMarkVerified({ request, db }) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = isoDate(parsed.body.on) || today();

  const { matched, unmatched } = matchLeadsByUrl(await db.getLeadsForUrlMatch(), parsed.urls);
  const stamped = await db.markVerified(matched.map((l) => l.id), on);
  // The tracker page prints this column as "Confirmed live <date>" on every
  // lead, so a stamp is a change a viewer sees and the "last updated" banner
  // should say so. Only when something actually moved: a report that matched
  // nothing changed nothing.
  if (stamped > 0) await db.touchUpdated();

  return json({ stamped, unmatched: unmatched.length, unmatchedUrls: unmatched, on });
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
 * rule lives here, once, and the entry points are reduced to fetching leads
 * and shaping JSON. Duplicating it is the exact failure this whole line of
 * work exists to prevent - which is also why this module holds the by-id entry
 * point below rather than ./update.js holding a copy of the policy.
 *
 * @param {import("../db.js").Db} db
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
  const removed = await db.deleteLeadAndScreen(lead, DELISTED_REASON, on, "run");
  return { kept: false, removed };
}

/**
 * The by-id entry point: POST /api/update with a `delistedOn` date, called
 * from ./update.js. Kept because a nightly run may still be part-way through a
 * night on a prompt fetched before /api/delist existed, so it keeps working and
 * keeps its exact response shape. Nothing in the client calls it - the tracker
 * page has no delisting control, it only ever reads the consequences.
 */
export async function removeDelistedLead(db, id, on) {
  const lead = await db.getLead(id);
  if (!lead) return json({ error: "lead not found" }, 404);

  const { kept, removed } = await delistLead(db, lead, on);
  if (kept) return json({ ok: true, lead, removed: false, reason: "applied to - kept" });

  await db.touchUpdated();
  return json({ ok: true, removed, id: lead.id, screened: lead.url });
}

/**
 * POST /api/delist - requires a Bearer token. Body `{ search, on, urls: [...] }`
 * -> `{ removed, kept, unmatched, unmatchedUrls, on }`.
 *
 * The by-URL entry point: one call reporting every posting a run confirmed dead
 * tonight. It replaces a run carrying lead ids from step 1b all the way to step
 * 8, issuing one curl per dead lead, and tallying `removed:true` against
 * `removed:false` itself - bookkeeping the server can do exactly and a model
 * can only do approximately.
 *
 * `on` must be a real YYYY-MM-DD or the whole call is refused, same as the
 * by-id path and for the same reason: what this triggers is a permanent delete,
 * the caller is an LLM, and "unknown" or "today" is not a report of anything.
 * Refused for the batch as a whole rather than per URL, because a date that
 * isn't a date says the run doesn't know what day it is, which is not a thing
 * to act on partially.
 *
 * The leads are delisted one at a time rather than in parallel: each one is
 * already a two-statement transaction (db.deleteLeadAndScreen), and a night
 * where a hundred postings came down should not turn into a hundred concurrent
 * transactions against the same table to save a few hundred milliseconds on a
 * scheduled job nobody is waiting on.
 */
export async function handleDelistUrls({ request, db }) {
  const parsed = await parseUrlReport(request, db);
  if (parsed.error) return parsed.error;

  const on = isoDate(typeof parsed.body.on === "string" ? parsed.body.on.trim() : "");
  if (!on) return json({ error: "on must be YYYY-MM-DD" }, 400);

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
