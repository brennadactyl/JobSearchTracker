/**
 * Who is calling: exchanging a password for a token, giving one back, saying
 * who a token belongs to, and provisioning the people who hold them.
 *
 * ---- Auth. A person has a name and a password; they hold bearer tokens
 * (sessions). Passwords are seen by exactly two handlers in this whole
 * codebase, and both are here - every other route resolves a token to a user
 * before its module is reached; see ../auth.js for the crypto and ../index.js
 * for the resolution.
 *
 * These are also the only routes that take a raw `d1` rather than a scoped
 * `Db`: login has no session yet to have scoped one from, and user
 * provisioning names its subject in the body rather than being the caller.
 */

import {
  bearer,
  createSession,
  deleteSession,
  getUserByName,
  upsertUser,
  verifyPassword,
} from "../auth.js";
import { json, readJson, unauthorized } from "../http.js";

/**
 * POST /api/login - public. Body `{ name, password, label? }` ->
 * `{ token, user }` or 401.
 *
 * Exchanges a name and password for a session token. The only handler a
 * password reaches besides handleUpsertUser, and the only place the name
 * means anything - every other route identifies the caller by token alone.
 *
 * One message for both "no such name" and "wrong password", on purpose: told
 * apart, they turn this into a way to enumerate who has an account here.
 * `label` is where the caller says what the token is for ('browser', or
 * 'scheduled-search' for the long-lived one a headless run keeps on disk), so
 * it can be revoked later by what it is rather than by guessing which opaque
 * string is which.
 */
export async function handleLogin({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name || !password) return json({ error: "name and password are required" }, 400);

  const user = await getUserByName(env.DB, name);
  if (!(await verifyPassword(password, user))) {
    return json({ error: "that name and password don't match" }, 401);
  }

  const token = await createSession(env.DB, user.id, typeof body.label === "string" ? body.label : "browser");
  return json({ token, user: { id: user.id, name: user.name } });
}

/**
 * POST /api/logout - requires a Bearer token.
 *
 * Revokes exactly the token that made the request - not every session the
 * person holds, so logging out of a browser never kills the scheduled search's
 * credential. Reaching this handler at all means the token still resolved;
 * logging out twice 401s at the routing layer, which is the same answer by a
 * different route.
 */
export async function handleLogout({ env, token }) {
  await deleteSession(env.DB, token);
  return json({ ok: true });
}

/**
 * POST /api/users - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ name, password }`.
 *
 * Creates a user, or sets an existing one's password. Gated by the ADMIN_TOKEN
 * worker secret rather than by a session: there is no self-signup here, and
 * whoever operates the deployment provisions people by hand.
 *
 * It doubles as password reset because nothing else in the system can run
 * PBKDF2 - without this, a forgotten password would mean deriving a hash
 * offline and hand-writing it into D1.
 */
export async function handleUpsertUser({ request, env }) {
  const admin = env.ADMIN_TOKEN;
  if (!admin || bearer(request) !== admin) return unauthorized();

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) return json({ error: "name is required" }, 400);
  // Long rather than complex, and enforced here because /api/login has no rate
  // limiting in front of it - see server/README.md.
  if (password.length < 12) return json({ error: "password must be at least 12 characters" }, 400);

  const result = await upsertUser(env.DB, name, password);
  return json(result, result.created ? 201 : 200);
}

/** GET /api/me - requires a Bearer token -> `{ id, name }`. */
export function handleGetMe({ user }) {
  return json({ id: user.id, name: user.name });
}
