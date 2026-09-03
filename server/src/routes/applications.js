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

