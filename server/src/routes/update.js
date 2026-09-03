/**
 * The generic field-write: one lead's status/notes, or one application record,
 * upserted. It spans both resources, which is why it sits in its own module
 * rather than in ./leads.js or ./applications.js.
 *
 * Status changes go through the two purpose-built routes instead
 * (./leads.js's handleSetLeadStatus and ./applications.js's
 * handleSetApplicationStatus), which validate the value and own the side
 * effects - application creation, stage-date stamping - that a plain field
 * write can't.
 */

import { json, readJson } from "../http.js";
import { isoDate, unknownTrack } from "../validate.js";
import { removeDelistedLead } from "./delisting.js";

/**
 * POST /api/update - requires a Bearer token. Body
 * `{ type: "lead"|"application", ... }`.
 */
export async function handleUpdate({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (body.type === "lead") {
    // `delistedOn` is the one field here the server acts on rather than
    // stores. A scheduled search sending it is reporting a fact it observed -
    // "this posting is gone from the internet" - and what the tracker does
    // about that is a decision this codebase owns, not the caller's: see
    // ./delisting.js's removeDelistedLead. Every other key is a plain field
    // write.
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
      const on = isoDate(body.delistedOn.trim());
      if (!on) return json({ error: "delistedOn must be YYYY-MM-DD" }, 400);
      return removeDelistedLead(db, body.id, on);
    }

    // `search` moves the lead to another of this user's tabs. It's the one
    // field here that can fail on its own terms, so both failures are caught
    // rather than left to surface as a 500: an unknown track key is the same
    // drift /api/runs rejects (a lead filed under a key no tab displays is a
    // lead nobody sees again), and the destination may already hold this url,
    // which UNIQUE(user_id, search, url) refuses.
    const move = typeof body.search === "string" && body.search ? body.search : "";
    if (move && !(await db.trackExists(move))) return unknownTrack(move);

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
