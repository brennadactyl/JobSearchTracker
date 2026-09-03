/**
 * The one read the tracker webpage makes on load: everything this person has,
 * in a single request.
 */

import { json } from "../http.js";

/**
 * GET /api/data - requires a Bearer token ->
 * `{ user, updated, leads[], applications[], screened[], tracks[], settings }`.
 */
export async function handleGetData({ db, user }) {
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
