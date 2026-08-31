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
 * building the one `Db` instance (see ./db.js) each request's handlers share.
 * All D1 access lives in db.js; all request parsing/validation/response
 * shaping lives in api.js. Nothing here talks to `env.DB` directly.
 *
 * Routes:
 *   GET  /api/data           requires Bearer token -> { updated, leads[], applications[], screened[] }
 *   POST /api/leads          requires Bearer token -> body: { leads: [...] }
 *                            appends leads not already present for the same
 *                            (search, url) pair (DB-enforced UNIQUE constraint
 *                            + INSERT OR IGNORE - atomic, race-free); never
 *                            touches existing status/notes
 *   POST /api/runs           requires Bearer token -> body: { search, status?, leadsAdded?,
 *                            screenedAdded?, delisted?, note?, at?, on? }
 *                            records that one track's scheduled search just
 *                            finished. Called at the end of EVERY run,
 *                            including ones that found nothing - that's the
 *                            case no other table can distinguish from the
 *                            search never having fired. 404s on a track key
 *                            that isn't configured rather than creating an
 *                            orphan row. See migrations/0001_schema.sql.
 *   POST /api/screened       requires Bearer token -> body: { screened: [...] }
 *                            appends postings the search decided NOT to add
 *                            as a lead (dead-on-arrival, outside the US,
 *                            wrong level, duplicate) - same dedup shape as
 *                            /api/leads. See migrations/0001_schema.sql.
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
 *                            still empty. "Applied" stamps dateApplied the
 *                            same way; "To Apply" (not applied to yet)
 *                            clears it instead
 *   POST /api/delete-application  requires Bearer token -> body: { id } ->
 *                            removes one application row (used by the
 *                            client's "remove" control; leads are never
 *                            deleted, only re-statused)
 *   GET  /api/config         requires Bearer token -> { tracks[], settings }
 *                            - the per-installer config (track tabs, tab
 *                            labels, display title, priority-location rules,
 *                            staleness threshold) that the client renders off
 *                            instead of a baked-in TRACKS object, so this
 *                            same code serves any installer. Each track
 *                            carries its own `last_run` (from search_runs).
 *   POST /api/config         requires Bearer token -> body: { tracks?, display_title?,
 *                            overview_label?, applications_label?, stale_run_hours?,
 *                            priority_locations? }
 *                            - sets that config (see handleSetConfig in api.js).
 *                            Writing `tracks` also keeps search_runs 1:1 with
 *                            it - new tracks gain a "never ran" row, removed
 *                            tracks lose theirs.
 *   OPTIONS *                 CORS preflight for any of the above -> 204 + CORS_HEADERS
 *
 * Schema: see ../migrations/. Persistence: see ./db.js. Handlers: see ./api.js.
 */

import { Db } from "./db.js";
import {
  authorized,
  unauthorized,
  json,
  corsPreflight,
  CORS_HEADERS,
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
    const db = new Db(env.DB);

    if (url.pathname === "/api/data" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      return handleGetData(db);
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      return handleGetConfig(db);
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetConfig(request, db);
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddLeads(request, db);
    }

    if (url.pathname === "/api/runs" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleRecordRun(request, db);
    }

    if (url.pathname === "/api/screened" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddScreened(request, db);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleUpdate(request, db);
    }

    // Path-param routes (the only ones in this file) - matched by regex
    // instead of the exact-string checks above.
    let m;
    if ((m = url.pathname.match(/^\/api\/leads\/(\d+)\/status$/)) && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetLeadStatus(request, db, m[1]);
    }

    if ((m = url.pathname.match(/^\/api\/applications\/(\d+)\/status$/)) && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetApplicationStatus(request, db, m[1]);
    }

    if (url.pathname === "/api/delete-application" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleDeleteApplication(request, db);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
