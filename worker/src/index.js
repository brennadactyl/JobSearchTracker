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
 *                            application record
 *   POST /api/delete-application  requires Bearer token -> body: { id } ->
 *                            removes one application row (used by the
 *                            page's "remove" control; leads are never
 *                            deleted, only re-statused)
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
  handleDeleteApplication,
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
      const [leads, applications, meta] = await Promise.all([
        env.DB.prepare("SELECT * FROM leads ORDER BY id").all(),
        env.DB.prepare("SELECT * FROM applications ORDER BY id").all(),
        env.DB.prepare("SELECT value FROM meta WHERE key = 'updated'").first(),
      ]);
      return json({
        updated: meta ? meta.value : null,
        leads: leads.results,
        applications: applications.results,
      });
    }

    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleAddLeads(request, env);
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleUpdate(request, env);
    }

    if (url.pathname === "/api/delete-application" && request.method === "POST") {
      if (!authorized(request, env)) return unauthorized();
      return handleDeleteApplication(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
