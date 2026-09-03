/**
 * The one destructive route in the API, and the only write a scheduled search
 * cannot reach.
 *
 * Like ./accounts.js's user provisioning, it takes the ADMIN_TOKEN secret
 * rather than a session and names its subject in the body, so it builds its own
 * `Db` (see ../db.js) rather than being handed one already scoped to a caller.
 * Nothing here queries d1 directly; the scoping rule is unchanged.
 */

import { bearer, getUserByName } from "../auth.js";
import { Db } from "../db.js";
import { json, readJson, unauthorized } from "../http.js";

/**
 * POST /api/purge - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ user, search, dryRun? }`.
 *
 * Removes every row belonging to a search that has been retired - the leads,
 * the postings it screened, its slice of the company rotation, its run record,
 * in one transaction.
 *
 * This exists because there was no way to do it. Retiring a track (dropping it
 * from POST /api/config's `tracks`) removes the tab but deliberately keeps the
 * rows, so leads are never lost to a config edit. The rows then sit there
 * displayed by nothing: 145 leads and 185 screened rows accumulated that way
 * under one retired track. The only route that could delete a lead was the
 * delisting report, which writes a "posting taken down" screened row for every
 * lead it removes - so using it here would have invented a screening for 145
 * postings nobody screened, in the table the next run reads back.
 *
 * ---- Two independent guards, because this is the only destructive route in
 * the API and it is permanent.
 *
 * It takes the ADMIN_TOKEN, not a session. Every other write here is reachable
 * with the long-lived token a scheduled search keeps on disk, and a nightly
 * LLM run should not be one prompt-injection away from a route that empties a
 * table. The admin secret is held by whoever operates the deployment and is
 * never given to a run, so this route is simply not part of the surface a run
 * can touch.
 *
 * And it refuses any key that is still a configured track. That is the guard
 * that matters even for a correct caller: it means the route can only ever
 * delete data that no tab displays, and a typo naming a live search is an
 * error rather than a catastrophe. Retiring the track first is the deliberate
 * step that makes its data eligible - you cannot skip straight to the delete.
 *
 * Application rows survive with their `leadId` cleared, so the record of having
 * applied is never lost to this. The response reports what it removed per
 * table, and `applications` is how many application rows had their `leadId`
 * cleared rather than being deleted - see db.purgeSearch for why those survive.
 */
export async function handlePurgeSearch({ request, env }) {
  const admin = env.ADMIN_TOKEN;
  if (!admin || bearer(request) !== admin) return unauthorized();

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.user === "string" ? body.user.trim() : "";
  const key = typeof body.search === "string" ? body.search.trim() : "";
  if (!name || !key) return json({ error: "user and search are required" }, 400);

  const user = await getUserByName(env.DB, name);
  if (!user) return json({ error: `no user named "${name}"` }, 404);

  const db = new Db(env.DB, user.id);
  if (await db.trackExists(key)) {
    return json(
      {
        error: `"${key}" is a configured track for ${user.name} - remove it from the track list first if you mean to retire it`,
      },
      409
    );
  }

  const counts = await db.countSearchRows(key);
  if (counts.leads === 0 && counts.screened === 0 && counts.sweeps === 0 && counts.runs === 0) {
    return json({ purged: counts, note: `nothing stored under "${key}" for ${user.name}` });
  }

  // `dryRun` so the rows can be counted before anyone commits to removing
  // them. The counts come from the same method the purge uses, so what this
  // reports is what that would delete.
  if (body.dryRun) return json({ dryRun: true, wouldPurge: counts });

  const purged = await db.purgeSearch(key);
  await db.touchUpdated();
  return json({ purged });
}
