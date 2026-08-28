/**
 * Job Search Tracker - Cloudflare Worker
 *
 * Serves the tracker webpage (page.html) and a small JSON API, backed by
 * D1 (SQLite). No dependency on any particular AI tool - just HTTP + D1, so
 * the headless search CLI can update it with a plain `curl` call and the
 * page can edit it with `fetch`.
 *
 * Routes:
 *   GET  /                   unauthenticated shell; JS prompts for the token,
 *                            then calls the API routes below with it
 *   GET  /api/data           requires Bearer token -> { updated, leads[], applications[] }
 *   POST /api/leads          requires Bearer token -> body: { leads: [...] }
 *                            appends leads not already present for the same
 *                            (search, url) pair (DB-enforced UNIQUE constraint
 *                            + INSERT OR IGNORE - atomic, race-free); never
 *                            touches existing status/notes
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
 *                            page's "remove" control; leads are never
 *                            deleted, only re-statused)
 *   GET  /api/config         requires Bearer token -> { tracks[], settings }
 *                            - the per-installer config (track tabs, display
 *                            title, priority-location rules) that page.html
 *                            renders off instead of a baked-in TRACKS object,
 *                            so this same code serves any installer.
 *   POST /api/config         requires Bearer token -> body: { tracks?, display_title?, priority_locations? }
 *                            - sets that config (see handleSetConfig in api.js)
 *
 * Schema: see ../migrations/. Handlers: see ./api.js. Page: see ./page.html
 * (imported as raw text - see the `rules` entry in ../wrangler.toml).
 */

import PAGE_HTML from "./page.html";
import {
  authorized,
  unauthorized,
  json,
  handleAddLeads,
  handleUpdate,
  handleSetLeadStatus,
  handleSetApplicationStatus,
  handleDeleteApplication,
  getTracksAndSettings,
  handleGetConfig,
  handleSetConfig,
} from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/data" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      const [leads, applications, meta, config] = await Promise.all([
        env.DB.prepare("SELECT * FROM leads ORDER BY id").all(),
        env.DB.prepare("SELECT * FROM applications ORDER BY id").all(),
        env.DB.prepare("SELECT value FROM meta WHERE key = 'updated'").first(),
        getTracksAndSettings(env),
      ]);
      return json({
        updated: meta ? meta.value : null,
        leads: leads.results,
        applications: applications.results,
        tracks: config.tracks,
        settings: config.settings,
      });
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      if (!authorized(request, env)) return unauthorized();
      return handleGetConfig(env);
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetConfig(request, env);
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddLeads(request, env);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleUpdate(request, env);
    }

    // Path-param routes (the only ones in this file) - matched by regex
    // instead of the exact-string checks above.
    let m;
    if ((m = url.pathname.match(/^\/api\/leads\/(\d+)\/status$/)) && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetLeadStatus(request, env, m[1]);
    }

    if ((m = url.pathname.match(/^\/api\/applications\/(\d+)\/status$/)) && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleSetApplicationStatus(request, env, m[1]);
    }

    if (url.pathname === "/api/delete-application" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleDeleteApplication(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
