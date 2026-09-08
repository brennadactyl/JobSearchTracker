/**
 * The route table: which method and path map to which handler, in two lists
 * split by whether the caller is known yet.
 *
 * That split is the whole access-control story, and it is a list rather than a
 * flag on each row so it cannot be got wrong by omission. Every entry in
 * PUBLIC_ROUTES is there for a stated reason - see the two kinds below;
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

import {
  handleGetMe,
  handleLogin,
  handleLogout,
  handleMintToken,
  handleSignup,
  handleUpsertUser,
} from "./accounts.js";
import { handlePurgeSearch } from "./admin.js";
import {
  handleDeleteApplication,
  handleGetAutofillQueue,
  handleReportAutofill,
  handleRequeueAutofill,
  handleSetApplicationStatus,
} from "./applications.js";
import { handleGetConfig, handleSetConfig } from "./config.js";
import { handleGetCoverage, handleRecordSweeps } from "./coverage.js";
import { handleGetData } from "./data.js";
import {
  handleCompleteIntake,
  handleDeleteIntakeFile,
  handleGetIntake,
  handleGetIntakeFile,
  handleGetIntakeQueue,
  handleSubmitIntake,
  handleUploadIntakeFile,
} from "./intake.js";
import { handleCheckInvite, handleCreateInvite, handleListInvites } from "./invites.js";
import { handleDelistUrls, handleMarkVerified } from "./delisting.js";
import { handleAddLeads, handleDeleteLeads, handleSetLeadStatus } from "./leads.js";
import { handleGetAutofillPrompt, handleGetPrompt } from "./prompt.js";
import { handleRecordRun } from "./runs.js";
import { handleAddScreened, handleGetDedup } from "./screened.js";
import { handleUpdate } from "./update.js";

/**
 * The routes that run before anyone is known, in two kinds.
 *
 * **No credential yet.** Exchanging a password for a token, checking whether
 * an invite link is still good, and spending one to create an account. The
 * last two are the self-service half of onboarding: whoever holds the link has
 * no session because they have no account, which is the entire point.
 *
 * **The operator, holding the ADMIN_TOKEN secret.** Provisioning or resetting
 * a user, minting a user's long-lived search token, the invite ledger, the
 * intake queue and its attachments, closing an intake out, and purging a
 * retired search. Every one of them names its subject in the body or the path
 * rather than being the caller, which is why a session would be the wrong
 * credential - and sitting here means a session token is not even a candidate
 * credential for any of them. Each checks the secret through validate.js's
 * notAdmin as its first statement.
 *
 * Nothing else belongs in this list. A route that has a caller goes below.
 *
 * @type {Array<[string, string|RegExp, Function]>}
 */
export const PUBLIC_ROUTES = [
  ["POST", "/api/login", handleLogin],
  ["POST", "/api/signup", handleSignup],
  ["GET", /^\/api\/invite\/([^/]+)$/, handleCheckInvite],
  ["POST", "/api/users", handleUpsertUser],
  ["POST", "/api/tokens", handleMintToken],
  ["POST", "/api/invites", handleCreateInvite],
  ["GET", "/api/invites", handleListInvites],
  // The onboarding run's three. `/api/intake/pending` is a fixed path and the
  // session route `/api/intake` is a different one, so neither can shadow the
  // other however this list is ordered.
  ["GET", "/api/intake/pending", handleGetIntakeQueue],
  ["GET", /^\/api\/intake\/file\/(\d+)$/, handleGetIntakeFile],
  ["POST", "/api/intake/complete", handleCompleteIntake],
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
  // Setting up your own search: what you want, and the documents it should be
  // built from. See ./intake.js for why this is a queue rather than a form
  // that writes config directly.
  ["GET", "/api/intake", handleGetIntake],
  ["POST", "/api/intake", handleSubmitIntake],
  ["POST", "/api/intake/files", handleUploadIntakeFile],
  ["POST", "/api/intake/files/delete", handleDeleteIntakeFile],
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
  // The overnight fill of an application added as nothing but a URL: which
  // postings tonight's run should read, and what it read off them. Two routes
  // and no third - nothing re-queues a row, because a row is read once (see
  // ../../migrations/0009_application_autofill.sql). `pending` can't collide
  // with the numeric-id route above - an id is \d+ - so this needs no
  // ordering care, unlike the prompt pair below.
  ["GET", "/api/applications/pending", handleGetAutofillQueue],
  ["POST", "/api/applications/autofill", handleReportAutofill],
  // Not a retry - see the handler. Nothing on the page or on a schedule calls
  // this; it is how a person who has just improved the reader gives rows that
  // failed under the old one a real first read.
  ["POST", "/api/applications/requeue", handleRequeueAutofill],
  ["GET", /^\/api\/dedup\/([^/]+)$/, handleGetDedup],
  ["GET", /^\/api\/coverage\/([^/]+)$/, handleGetCoverage],
  ["POST", "/api/coverage", handleRecordSweeps],
  // `_applications` is a reserved key under /api/prompt, not a track: it is
  // the nightly fill's prompt, and it sits above the track route because
  // matchRoute takes the first match and the pattern below would otherwise
  // swallow it and 404 on a track nobody configured. The leading underscore
  // is what keeps it out of the space installers actually name tracks in -
  // run-search.ps1 fetches it like any other, as `-Task _applications`.
  ["GET", "/api/prompt/_applications", handleGetAutofillPrompt],
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
