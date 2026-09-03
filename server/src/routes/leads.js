/**
 * Leads: the postings a search found and filed into one of this person's tabs.
 *
 * Three ways in and one way out. A run appends them (/api/leads), a person
 * moves one to "Applied" (/api/leads/:id/status), and a person clears the ones
 * they have decided against (/api/delete-leads). The fourth thing that removes
 * a lead - a run reporting the posting taken down - lives in ./delisting.js,
 * because that rule is shared with /api/update and must not be written twice.
 */

import { DELISTED_REASON } from "../db.js";
import { excludedCompanyMatcher } from "../exclude.js";
import { json, readJson } from "../http.js";
import { isoDate, today, unknownTrackResponse } from "../validate.js";

// Valid status values, duplicated from page.html's LEAD_STATUS (same
// intentional-duplication pattern as EXTRA_FIELDS in db.js - no build step ties
// client and server together). Used to validate the status-change endpoint
// below; the generic /api/update path (./update.js) is left unvalidated on
// purpose - see handleSetLeadStatus.
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"];

/**
 * POST /api/leads - requires a Bearer token. Body `{ on?, leads: [...] }` ->
 * `{ added, duplicates, excluded }`.
 *
 * Appends leads whose posting this user doesn't already have. Two layers: a
 * canonical-URL filter (see ../url.js) over the DB-enforced UNIQUE constraint,
 * so the same posting under a different URL is caught too. Scoped to the
 * *search*, so one branched run cannot file a posting into two of its own tabs.
 * `on` is the caller's local date, used for found/verified.
 */
export async function handleAddLeads({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

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
  const on = isoDate(body.on);

  // One read serves both guards below: the track list says whether these rows
  // have a tab to land in, the settings build the exclusion matcher. This was
  // excluderFor(db), which fetches exactly this and discards the tracks.
  const { tracks, settings } = await db.getTracksAndSettings();

  // Checked before the exclusion filter and before any write, because a
  // drifted key is drift whether or not the payload also happens to be all
  // excluded companies - and the early return below would otherwise answer a
  // mistyped search with a cheerful `{ added: 0 }`.
  const drift = unknownTrackResponse(tracks, valid);
  if (drift) return drift;

  // Companies this person will not work for, enforced rather than asked for.
  // The list has been structured config for a while, but the only thing acting
  // on it was a sentence in the prompt, and it leaked: lead 238 in the live
  // data is xAI, which is on the list. A sentence is a request; this is the
  // answer. See ../exclude.js for the matching rules.
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

/**
 * POST /api/leads/:id/status - requires a Bearer token. Body `{ status }`.
 *
 * Atomically moves a lead to "Applied" and creates its application row -
 * replaces the client's old two-sequential-POST approach (set status, then
 * a separate call to create the application), which could leave a lead
 * marked Applied with no application if the second call never landed.
 * db.setLeadStatusAndMaybeCreateApplication runs both writes as one real
 * D1 transaction: if either statement fails, both roll back.
 *
 * The duplicate-application guard here is a read-then-conditionally-write
 * within one request, not a schema-enforced constraint - it doesn't
 * protect against two genuinely concurrent requests for the same lead
 * (e.g. two devices). Still a strict improvement over the previous
 * client-side guard, which trusted stale local state and never
 * re-checked the server at all.
 */
export async function handleSetLeadStatus({ request, db, params }) {
  const id = params[0];
  const body = await readJson(request);
  if (body instanceof Response) return body;

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
          location: lead.location || "",
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

/** Longest `reason` accepted. It's a note on a screened row, not a document. */
const MAX_REASON = 200;

/**
 * POST /api/delete-leads - requires a Bearer token. Body `{ ids: [...],
 * reason }` -> `{ removed, kept, unmatched, reason }`.
 *
 * Removing postings a person has decided against, by id, with the reason they
 * decided it.
 *
 * This is the third way a lead can leave the board, and it exists because the
 * other two can't say what this one says:
 *
 *   - /api/delist is a nightly run reporting a posting taken down. It writes
 *     the fixed reason "posting taken down". Reusing it here would file a
 *     screening nobody performed, in the table tomorrow's run reads back as
 *     already-seen - the same objection that kept purgeSearch from reusing it.
 *   - /api/purge takes a whole retired track and needs the ADMIN_TOKEN. It
 *     refuses any key still configured, so it cannot touch a live tab.
 *
 * So `reason` is required rather than defaulted. The screened row it leaves is
 * the only lasting record of why the posting went, and a default would make
 * every removal claim a motive the person never gave. It is also what stops
 * the removal undoing itself: without a screened row tomorrow's run rediscovers
 * the URL, finds nothing tracking it, and adds it straight back.
 *
 * A lead an application points at is kept, exactly as delistLead keeps it, and
 * for the same reason - the application is the least recoverable row in this
 * database and deleting the lead would strand it. Tested by the application
 * row, not by status "Applied", because a lead can carry an application while
 * sitting in another status. Unlike purgeSearch, this does not clear leadId to
 * remove it anyway: purging is retiring a whole search on purpose, while this
 * is one posting at a time, and silently severing an application from a
 * one-click removal is not a trade worth making. The caller is told, in
 * `kept`, so nothing looks like it worked when it didn't.
 *
 * Batched because the realistic use is a triage pass - narrowing a search's
 * locations leaves a few hundred leads that no longer qualify - and 300
 * sequential round trips is a worse answer than one call. Ids not belonging to
 * this user simply don't resolve, since `db` is already scoped to them, and
 * come back in `unmatched` rather than as an error: from outside, another
 * person's lead id and a deleted one are indistinguishable, which is the point.
 */
export async function handleDeleteLeads({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  let reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return json({ error: "missing reason - say why these are being removed; it is stored on the screened row" }, 400);
  }
  if (reason.length > MAX_REASON) {
    return json({ error: `reason must be ${MAX_REASON} characters or fewer` }, 400);
  }

  // Same reservation handleAddScreened makes, for the same reason and now for a
  // second caller-reason path. countRunActivity splits a day's screened rows on
  // DELISTED_REASON to separate "a posting we tracked came down" from "a
  // candidate we rejected", and those land in different columns of the run
  // record. "Posting taken down" is an entirely natural thing to type into a
  // required "why are you removing this?" box - the page says those words
  // elsewhere - and that row would then be counted as a delisting, inflating
  // that day's `delisted` and deflating `screenedAdded` for the track. The
  // reason is still recorded, just not in the words that already mean something
  // else. deleteLeadAndScreen itself can't refuse the string: delistLead is a
  // legitimate caller that passes exactly that sentinel.
  if (reason.toLowerCase() === DELISTED_REASON) reason = "removed by hand";

  const ids = Array.isArray(body.ids) ? body.ids : body.id != null ? [body.id] : [];
  if (!ids.length) return json({ error: "missing ids" }, 400);

  let removed = 0;
  const kept = [];
  const unmatched = [];
  for (const rawId of ids) {
    const lead = await db.getLead(rawId);
    if (!lead) {
      unmatched.push(rawId);
      continue;
    }
    if (await db.getApplicationByLeadId(lead.id)) {
      kept.push(lead.id);
      continue;
    }
    // 'hand': a person is clearing this off their own board, which is not the
    // night's search work and must not be counted as it. The screened row is
    // still written, so tomorrow's run doesn't rediscover and re-add the
    // posting - it just isn't attributed to a run. See
    // migrations/0007_screened_added_by.sql.
    if (await db.deleteLeadAndScreen(lead, reason, null, "hand")) removed++;
  }

  if (removed) await db.touchUpdated();
  return json({ removed, kept, unmatched, reason });
}
