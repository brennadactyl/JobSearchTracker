/**
 * How every response in this worker gets built, in one place.
 *
 * The route modules under ./routes/ never construct a `Response` themselves -
 * they return json(), text(), or one of the two canned refusals below. That is
 * what keeps CORS_HEADERS on every reply, including the error ones, which is
 * the case that actually breaks when each handler builds its own: a 404
 * without the header reaches the client as an opaque network failure with no
 * status to read.
 *
 * This worker is API-only (no page-serving) - the client is a separate
 * deployable (see ../../client/) that calls this API cross-origin, hence
 * CORS_HEADERS on every response. `*` rather than a specific origin: the
 * session token - not the origin - is the access boundary, and it is never a
 * cookie, so there is nothing here for a hostile origin to ride on the way a
 * cookie-authenticated API would have. Restricting the origin would add config
 * surface (one more per-deployment value to keep in sync with wherever the
 * client is hosted) without adding real security.
 */

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // charset spelled out: JSON is UTF-8 by definition and browsers assume so,
    // but Windows PowerShell 5.1's Invoke-RestMethod falls back to Latin-1
    // without it. A PowerShell client doing the documented GET-merge-POST on
    // /api/config would then read every em-dash in a prompt setting as
    // mojibake and write it back that way, silently corrupting the config it
    // was only meant to add a field to.
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * The parse-or-400 preamble every route taking a body opens with, which was
 * written out ten times before this existed. Returns the parsed body, or the
 * Response to hand straight back:
 *
 *     const body = await readJson(request);
 *     if (body instanceof Response) return body;
 *
 * @param {Request} request
 * @returns {Promise<Object|Response>}
 */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
}
