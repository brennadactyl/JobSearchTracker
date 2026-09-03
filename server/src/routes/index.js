/**
 * The route table: which method and path map to which handler, in two lists
 * split by whether the caller is known yet.
 *
 * That split is the whole access-control story, and it is a list rather than a
 * flag on each row so it cannot be got wrong by omission. PUBLIC_ROUTES is
 * three entries long and every one of them is there for a stated reason;
 * anything not in it is in SESSION_ROUTES, where ../index.js has already
 * resolved the bearer token to a person and built the `Db` scoped to them. A
 * route added later inherits that by default rather than by remembering to.
 *
 * Every handler takes one context object (see ../index.js's Ctx) and returns a
 * Response, so adding an endpoint is one line here and one exported function in
 * the module beside this one.
 *
 * The API reference lives with each handler; ../../README.md has the prose
 * version. Persistence: ../db.js. Schema: ../../migrations/.
 */

import { handleGetMe, handleLogin, handleLogout, handleUpsertUser } from "./accounts.js";
import { handlePurgeSearch } from "./admin.js";
import { handleDeleteApplication, handleSetApplicationStatus } from "./applications.js";
import { handleGetConfig, handleSetConfig } from "./config.js";
import { handleGetCoverage, handleRecordSweeps } from "./coverage.js";
import { handleGetData } from "./data.js";
import { handleDelistUrls, handleMarkVerified } from "./delisting.js";
import { handleAddLeads, handleDeleteLeads, handleSetLeadStatus } from "./leads.js";
import { handleGetPrompt } from "./prompt.js";
import { handleRecordRun } from "./runs.js";
import { handleAddScreened, handleGetDedup } from "./screened.js";
import { handleUpdate } from "./update.js";

/**
 * The routes that run before anyone is known. Three of them, and no more:
 * exchanging a password for a token, provisioning a user with the admin
 * secret, and purging a retired search with the same secret. The last two
 * name their subject in the body rather than being the caller, which is why a
 * session would be the wrong credential for them - and sitting here means a
 * session token is not even a candidate credential.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const PUBLIC_ROUTES = [
  ["POST", "/api/login", handleLogin],
  ["POST", "/api/users", handleUpsertUser],
  ["POST", "/api/purge", handlePurgeSearch],
];

/**
 * Everything else. By the time one of these runs, `ctx.user` is the person the
 * bearer token resolved to and `ctx.db` is a `Db` that can only see their rows -
 * so no handler checks ownership, because none can see anything to check.
 * Another user's lead id doesn't resolve, their track key reads as
 * unconfigured, their settings aren't in the result set.
 *
 * A RegExp path captures its groups into `ctx.params`, in order. The numeric-id
 * routes are deliberately stricter than the track-key ones: an id is a row this
 * database assigned, while a track key is an installer-chosen slug, so the
 * latter accept any single path segment and 404 on anything that isn't one of
 * this person's configured tracks.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const SESSION_ROUTES = [
  ["POST", "/api/logout", handleLogout],
  ["GET", "/api/me", handleGetMe],
  ["GET", "/api/data", handleGetData],
  ["GET", "/api/config", handleGetConfig],
  ["POST", "/api/config", handleSetConfig],
  ["POST", "/api/leads", handleAddLeads],
  ["POST", "/api/runs", handleRecordRun],
  ["POST", "/api/screened", handleAddScreened],
  ["POST", "/api/update", handleUpdate],
  // The two URL-set reports a nightly run makes about the postings it already
  // tracks: which are still live, and which have come down.
  ["POST", "/api/verified", handleMarkVerified],
  ["POST", "/api/delist", handleDelistUrls],
  ["POST", /^\/api\/leads\/(\d+)\/status$/, handleSetLeadStatus],
  ["POST", /^\/api\/applications\/(\d+)\/status$/, handleSetApplicationStatus],
  ["GET", /^\/api\/dedup\/([^/]+)$/, handleGetDedup],
  ["GET", /^\/api\/coverage\/([^/]+)$/, handleGetCoverage],
  ["POST", "/api/coverage", handleRecordSweeps],
  ["GET", /^\/api\/prompt\/([^/]+)$/, handleGetPrompt],
  ["POST", "/api/delete-application", handleDeleteApplication],
  ["POST", "/api/delete-leads", handleDeleteLeads],
];

/**
 * First route in the list whose method and path both match, or null.
 *
 * Method is checked before path, so a GET to a POST-only path falls through to
 * the 404 rather than being answered by the wrong handler.
 *
 * @param {Array<[string, string|RegExp, Function]>} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{handler: Function, params: string[]}|null}
 */
export function matchRoute(routes, method, pathname) {
  for (const [routeMethod, path, handler] of routes) {
    if (routeMethod !== method) continue;
    if (typeof path === "string") {
      if (path === pathname) return { handler, params: [] };
      continue;
    }
    const hit = pathname.match(path);
    if (hit) return { handler, params: hit.slice(1).map(decodeURIComponent) };
  }
  return null;
}
