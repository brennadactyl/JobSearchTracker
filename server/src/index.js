/**
 * Job Search Tracker - API worker
 *
 * API-only Cloudflare Worker backed by D1 (SQLite). No dependency on any
 * particular AI tool - just HTTP + D1, so the headless search CLI can
 * update it with a plain `curl` call and the client can edit it with
 * `fetch`. The client (the tracker webpage) is a separate deployable - see
 * ../../client/ - served from its own origin (Cloudflare Pages) and talking
 * to this worker cross-origin, hence the CORS handling below and in
 * api.js's json()/CORS_HEADERS. Server and client are versioned, deployed,
 * and updated independently; see each one's own README for its deploy flow.
 *
 * This file is routing only - which path/method maps to which handler - plus
 * resolving who is calling and building the one `Db` instance (see ./db.js)
 * their request's handlers share. All D1 access for a user's own data lives
 * in db.js; users and sessions live in auth.js; all request
 * parsing/validation/response shaping lives in api.js. Nothing here talks to
 * `env.DB` directly.
 *
 * ---- Auth, in one place. Every route below except the three public ones
 * resolves its bearer token to a person first, and hands the handlers a `Db`
 * already scoped to them:
 *
 *     const user = await getSessionUser(env.DB, bearer(request));
 *     const db = new Db(env.DB, user.id);
 *
 * That single line is the entire access-control story. No handler checks
 * ownership, because none can see anything to check: another user's lead id
 * doesn't resolve, their track key reads as unconfigured, their settings
 * aren't in the result set. A route added later inherits this by default
 * rather than by remembering to.
 *
 * Routes:
 *   POST /api/login          public -> body: { name, password, label? }
 *                            -> { token, user } | 401. The only route a
 *                            password reaches besides /api/users, and the
 *                            only one where the name matters.
 *   POST /api/logout         requires Bearer token -> revokes that one token
 *                            (not the caller's other sessions)
 *   POST /api/users          requires the ADMIN_TOKEN secret as Bearer ->
 *                            body: { name, password } - creates a user, or
 *                            resets an existing one's password. There is no
 *                            self-signup; this is how people are provisioned.
 *   GET  /api/me             requires Bearer token -> { id, name }
 *   GET  /api/data           requires Bearer token -> { user, updated, leads[], applications[], screened[], tracks[], settings }
 *   POST /api/leads          requires Bearer token -> body: { leads: [...] }
 *                            appends leads not already present for the same
 *                            (user, search, url) triple (DB-enforced UNIQUE
 *                            constraint + INSERT OR IGNORE - atomic,
 *                            race-free); never touches existing status/notes
 *   POST /api/runs           requires Bearer token -> body: { search, status?, leadsAdded?,
 *                            screenedAdded?, delisted?, note?, at?, on? }
 *                            records that one track's scheduled search just
 *                            finished. Called at the end of EVERY run,
 *                            including ones that found nothing - that's the
 *                            case no other table can distinguish from the
 *                            search never having fired. 404s on a track key
 *                            that isn't configured for this user rather than
 *                            creating an orphan row.
 *   POST /api/screened       requires Bearer token -> body: { screened: [...] }
 *                            appends postings the search decided NOT to add
 *                            as a lead - same dedup shape as /api/leads.
 *   POST /api/update         requires Bearer token -> body: { type: "lead"|"application", ... }
 *                            updates one lead's status/notes, or upserts one
 *                            application record. Generic field-whitelist
 *                            write - status changes go through the two
 *                            purpose-built routes below instead, which
 *                            validate the value and own the side effects
 *                            (application creation, stage-date stamping)
 *                            that a plain field write can't.
 *   POST /api/leads/:id/status       requires Bearer token -> body: { status }
 *                            validates against LEAD_STATUS; if the new
 *                            status is "Applied", atomically (one D1
 *                            batch/transaction) also creates the
 *                            corresponding application row, unless one
 *                            already exists for this lead
 *   POST /api/applications/:id/status  requires Bearer token -> body: { status }
 *                            validates against APP_STATUS; if the status
 *                            is a pipeline stage with a Stage history
 *                            column (STAGE_DATE_MAP), stamps it with
 *                            today's date, but only if that column is
 *                            still empty
 *   POST /api/delete-application  requires Bearer token -> body: { id } ->
 *                            removes one application row (used by the
 *                            client's "remove" control; leads are never
 *                            deleted, only re-statused)
 *   GET  /api/config         requires Bearer token -> { tracks[], settings }
 *                            - this user's config (track tabs, tab labels,
 *                            display title, priority-location rules,
 *                            staleness threshold) that the client renders off
 *                            instead of a baked-in TRACKS object, plus each
 *                            track's search config and the prose settings
 *                            prompt.js composes the daily prompt from. Each
 *                            track carries its own `last_run`.
 *   POST /api/config         requires Bearer token -> body: { tracks?, display_title?,
 *                            overview_label?, applications_label?, stale_run_hours?,
 *                            priority_locations?, geo_scope_line?, scope_clause?,
 *                            scope_disqualifier?, location_guidance?, footer_note?,
 *                            pronouns? }
 *                            - sets that config (see handleSetConfig in api.js).
 *                            Writing `tracks` also keeps search_runs 1:1 with
 *                            it - new tracks gain a "never ran" row, removed
 *                            tracks lose theirs.
 *   GET  /api/prompt/:key    requires Bearer token -> text/plain - the daily
 *                            search prompt for that track, composed from its
 *                            config (see ./prompt.js). What run-search.ps1
 *                            fetches instead of reading a prompt file off
 *                            whichever machine it's running on.
 *   OPTIONS *                 CORS preflight for any of the above -> 204 + CORS_HEADERS
 *
 * Schema: see ../migrations/. Persistence: see ./db.js. Handlers: see ./api.js.
 */

import { Db } from "./db.js";
import { bearer, getSessionUser } from "./auth.js";
import {
  unauthorized,
  corsPreflight,
  CORS_HEADERS,
  handleLogin,
  handleLogout,
  handleUpsertUser,
  handleGetMe,
  handleGetPrompt,
  handleAddLeads,
  handleAddScreened,
  handleRecordRun,
  handleUpdate,
  handleSetLeadStatus,
  handleSetApplicationStatus,
  handleDeleteApplication,
  handleGetConfig,
  handleSetConfig,
  handleGetData,
} from "./api.js";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);

    // The three routes that run before anyone is known: a preflight (above),
    // exchanging a password for a token, and provisioning a user with the
    // admin secret. Everything past this point has a resolved session.
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env.DB);
    }

    if (url.pathname === "/api/users" && request.method === "POST") {
      return handleUpsertUser(request, env, env.DB);
    }

    const token = bearer(request);
    const user = await getSessionUser(env.DB, token);
    if (!user) return unauthorized();
    const db = new Db(env.DB, user.id);

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout(env.DB, token);
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      return handleGetMe(user);
    }

    if (url.pathname === "/api/data" && request.method === "GET") {
      return handleGetData(db, user);
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      return handleGetConfig(db);
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
      return handleSetConfig(request, db);
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      return handleAddLeads(request, db);
    }

    if (url.pathname === "/api/runs" && request.method === "POST") {
      return handleRecordRun(request, db);
    }

    if (url.pathname === "/api/screened" && request.method === "POST") {
      return handleAddScreened(request, db);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      return handleUpdate(request, db);
    }

    // Path-param routes (the only ones in this file) - matched by regex
    // instead of the exact-string checks above.
    let m;
    if ((m = url.pathname.match(/^\/api\/leads\/(\d+)\/status$/)) && request.method === "POST") {
      return handleSetLeadStatus(request, db, m[1]);
    }

    if ((m = url.pathname.match(/^\/api\/applications\/(\d+)\/status$/)) && request.method === "POST") {
      return handleSetApplicationStatus(request, db, m[1]);
    }

    // Track keys are installer-chosen slugs, so this is deliberately looser
    // than the numeric-id routes above - handleGetPrompt 404s on anything
    // that isn't one of this user's configured tracks.
    if ((m = url.pathname.match(/^\/api\/prompt\/([^/]+)$/)) && request.method === "GET") {
      return handleGetPrompt(db, user, decodeURIComponent(m[1]));
    }

    if (url.pathname === "/api/delete-application" && request.method === "POST") {
      return handleDeleteApplication(request, db);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
