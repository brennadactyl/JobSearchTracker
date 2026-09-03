/**
 * Job Search Tracker - API worker
 *
 * API-only Cloudflare Worker backed by D1 (SQLite). No dependency on any
 * particular AI tool - just HTTP + D1, so the headless search CLI can update it
 * with a plain `curl` call and the client can edit it with `fetch`. The client
 * (the tracker webpage) is a separate deployable - see ../../client/ - served
 * from its own origin (Cloudflare Pages) and talking to this worker
 * cross-origin, hence the CORS handling in ./http.js. Server and client are
 * versioned, deployed, and updated independently; see each one's own README for
 * its deploy flow.
 *
 * This file is the entry point and nothing else: the CORS preflight, resolving
 * who is calling, building the one `Db` instance their request's handlers
 * share, and dispatching to the table in ./routes/index.js. It has no knowledge
 * of any individual endpoint.
 *
 *   ./routes/           one module per resource; each endpoint's contract and
 *                       reasoning is documented on its own handler
 *   ./routes/index.js   the route table - path/method -> handler
 *   ./http.js           every Response in the worker, plus CORS headers
 *   ./validate.js       the checks more than one route makes
 *   ./db.js             all D1 access for a user's own data
 *   ./auth.js           passwords, session tokens, who a token belongs to
 *   ./prompt.js         composes a track's daily search prompt
 *   ../migrations/      the schema
 *
 * Nothing here talks to `env.DB` directly, and neither does any route module -
 * it goes through `Db` (or, for the three routes with no session to scope one
 * from, a `Db` they construct themselves).
 *
 * ---- Auth, in one place. Every route outside PUBLIC_ROUTES resolves its
 * bearer token to a person first, and the handlers are handed a `Db` already
 * scoped to them:
 *
 *     const user = await getSessionUser(env.DB, bearer(request));
 *     const db = new Db(env.DB, user.id);
 *
 * That single line is the entire access-control story. No handler checks
 * ownership, because none can see anything to check: another user's lead id
 * doesn't resolve, their track key reads as unconfigured, their settings aren't
 * in the result set. A route added later inherits this by default rather than
 * by remembering to.
 */

import { bearer, getSessionUser } from "./auth.js";
import { Db } from "./db.js";
import { corsPreflight, CORS_HEADERS, unauthorized } from "./http.js";
import { matchRoute, PUBLIC_ROUTES, SESSION_ROUTES } from "./routes/index.js";

/**
 * What every handler receives. One object rather than a per-route argument
 * list, so the table in ./routes/index.js can be a flat list of rows instead of
 * a call site per endpoint.
 *
 * @typedef {Object} Ctx
 * @property {Request} request the incoming request
 * @property {Object} env worker bindings - `env.DB` (D1) and `env.ADMIN_TOKEN`
 * @property {URL} url the parsed request URL, for query parameters
 * @property {string[]} params the path captures, in order, already decoded
 * @property {string} token the caller's bearer token ("" on a public route)
 * @property {Object|null} user the person the token resolved to, or null
 * @property {Db|null} db a Db scoped to that person, or null on a public route
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);

    // The routes that run before anyone is known. Everything past this point
    // has a resolved session.
    const open = matchRoute(PUBLIC_ROUTES, request.method, url.pathname);
    if (open) {
      return open.handler({ request, env, url, params: open.params, token: "", user: null, db: null });
    }

    // Resolved before the path is matched, not after, so an unknown path
    // answers 401 rather than 404 to a caller who isn't logged in. Which routes
    // exist is not a secret worth much, but there is no reason to hand the list
    // out to someone holding no credential, and this is the ordering the worker
    // has always had.
    const token = bearer(request);
    const user = await getSessionUser(env.DB, token);
    if (!user) return unauthorized();

    const route = matchRoute(SESSION_ROUTES, request.method, url.pathname);
    if (!route) return new Response("Not found", { status: 404, headers: CORS_HEADERS });

    return route.handler({
      request,
      env,
      url,
      params: route.params,
      token,
      user,
      db: new Db(env.DB, user.id),
    });
  },
};
