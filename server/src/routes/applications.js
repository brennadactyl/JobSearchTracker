/**
 * Applications: the rows that outlive the postings they came from.
 *
 * An application is the least recoverable row in this database - it is the
 * record of having applied, and every deletion path elsewhere bends around
 * keeping it (see ./leads.js's handleDeleteLeads and ./delisting.js).
 */

import { json, readJson } from "../http.js";
import { isoDate } from "../validate.js";

// Valid status values, duplicated from page.html's APP_STATUS (same
// intentional-duplication pattern as EXTRA_FIELDS in db.js - no build step ties
// client and server together).
//
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

/**
 * POST /api/applications/:id/status - requires a Bearer token. Body
 * `{ status, date? }`.
 *
 * Validates status and, the first time an application reaches a stage
 * with a Stage history column (STAGE_DATE_MAP), stamps it with a date in
 * the same statement - but only if that column is still empty, so it
 * never overwrites a date the user corrected or backfilled by hand (that
 * still goes through the generic /api/update path - see ./update.js). The date
 * stamped is body.date when the client sends one - the tracker page
 * prompts for it whenever a status change is about to stamp a blank
 * column, since "today" is often wrong (the stage happened a few days
 * before it's getting logged) - falling back to today() if it's missing
 * or malformed, same as before this existed.
 *
 * Moving back to "To Apply" is the one case that clears a date instead of
 * stamping one: the row is being marked as not applied to yet, so the
 * applied date it was created with (insertApplication defaults it to today)
 * would be a lie, and leaving it there would also block the stamp above
 * from firing when the application actually goes out.
 */
export async function handleSetApplicationStatus({ request, db, params }) {
  const id = params[0];
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (!APP_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }
  const explicitDate = isoDate(body.date) || null;

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

/**
 * POST /api/delete-application - requires a Bearer token. Body `{ id }`.
 * Removes one application row (used by the client's "remove" control).
 */
export async function handleDeleteApplication({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (!body.id) return json({ error: "missing id" }, 400);
  const deleted = await db.deleteApplication(body.id);
  if (!deleted) return json({ error: "application not found" }, 404);
  await db.touchUpdated();
  return json({ ok: true });
}

// ------------------------------------------------- the overnight fill --
//
// Adding an application used to mean typing out nine fields off a posting the
// person had open in another tab. Now the URL is the whole of it: the row is
// created with a link and nothing else, and the nightly run that already
// opens and reads postings for the search tabs reads this one too and writes
// down what it says.
//
// None of this is visible on the tracker page, and that is the design rather
// than an omission - there is nothing here for the person to drive, watch or
// answer. Every application with a link and a gap in it is read once,
// automatically; the flag that records having read it exists so it isn't read
// twice. See migrations/0009_application_autofill.sql for the flag, db.js's
// getAutofillQueue for which rows qualify, and prompt.js's buildAutofillPrompt
// for what the run is told.

/** Longest `reason` accepted on a failed read. It's a line on a row, not a report. */
const MAX_REASON = 200;

/**
 * GET /api/applications/pending - requires a Bearer token ->
 * `{ applications: [{id, link}] }`.
 *
 * What the nightly fill run fetches. Two columns, because that is all it can
 * act on, and because this lands in a headless run's context every night -
 * the same reasoning as /api/dedup/:key. An empty list is the ordinary answer
 * on most nights and means "stop here", not "something is wrong".
 *
 * The server decides what belongs here (see db.getAutofillQueue) rather than
 * the caller filtering: a run asked to work out which applications look
 * unfinished is a run that can decide a filled-in row looks unfinished enough
 * to overwrite.
 */
export async function handleGetAutofillQueue({ db }) {
  return json({ applications: await db.getAutofillQueue() });
}

/**
 * POST /api/applications/autofill - requires a Bearer token. Body
 * `{ filled: [{id, company, title, location, team, setup, comp}],
 *    failed: [{id, reason}] }` -> `{ filled, failed, unmatched: [id] }`.
 *
 * One call for the whole night's work rather than one per row - the same
 * shape /api/verified and /api/delist take, for the same reason: a run asked
 * to make thirty calls makes twenty-nine of them and stops.
 *
 * A row only moves if it hasn't been read yet, so an id in `unmatched` means
 * it was deleted, or already reported, between the queue being fetched and
 * this call. That is not an error and there is nothing to retry - it is
 * reported so a run can say plainly what did and didn't land.
 */
export async function handleReportAutofill({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const filled = Array.isArray(body.filled) ? body.filled : [];
  const failed = Array.isArray(body.failed) ? body.failed : [];
  if (filled.length === 0 && failed.length === 0) {
    return json({ error: "no filled or failed rows provided" }, 400);
  }

  const unmatched = [];
  let filledCount = 0;
  let failedCount = 0;

  for (const row of filled) {
    if (!row || !row.id) continue;
    if (await db.applyAutofill(row.id, row)) filledCount++;
    else unmatched.push(row.id);
  }

  for (const row of failed) {
    if (!row || !row.id) continue;
    const reason = String(row.reason || "").trim() || "couldn't read the posting";
    if (await db.failAutofill(row.id, reason.slice(0, MAX_REASON))) failedCount++;
    else unmatched.push(row.id);
  }

  // Only a fill changes anything anyone looks at; a failure writes a flag and
  // a note that nothing displays, and shouldn't bump the page's "last updated"
  // banner into claiming something happened.
  if (filledCount > 0) await db.touchUpdated();
  return json({ filled: filledCount, failed: failedCount, unmatched });
}
