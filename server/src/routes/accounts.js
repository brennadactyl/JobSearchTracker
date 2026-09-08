/**
 * Who is calling: exchanging a password for a token, giving one back, saying
 * who a token belongs to, and provisioning the people who hold them.
 *
 * ---- Auth. A person has a name and a password; they hold bearer tokens
 * (sessions). Passwords are seen by exactly three handlers in this whole
 * codebase, and all three are here - login, admin provisioning, and invited
 * signup. Every other route resolves a token to a user before its module is
 * reached; see ../auth.js for the crypto and ../index.js for the resolution.
 *
 * Keeping that true is the reason signup lives in this file rather than beside
 * the invite routes it belongs to by subject matter: "every handler that
 * touches a password is in accounts.js" is a claim worth being able to check
 * by opening one file.
 *
 * These are also the only routes that take a raw `d1` rather than a scoped
 * `Db`: login has no session yet to have scoped one from, and user
 * provisioning names its subject in the body rather than being the caller.
 */

import {
  checkInvite,
  claimInvite,
  createSession,
  createUser,
  deleteSession,
  getUserByName,
  recordInviteUse,
  releaseInvite,
  upsertUser,
  verifyPassword,
} from "../auth.js";
import { json, readJson } from "../http.js";
import { notAdmin } from "../validate.js";

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
  const denied = notAdmin(request, env);
  if (denied) return denied;

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

/**
 * POST /api/signup - public, but only usable by someone holding an invite
 * code. Body `{ code, name, password }` -> `{ token, user }`, the same shape
 * login returns, so the page signs them straight in.
 *
 * The route that removes the operator from account creation. Before it, adding
 * a person meant the operator calling POST /api/users - which requires
 * choosing a password on someone else's behalf and then sending it to them,
 * usually over a chat that keeps it legible forever.
 *
 * ---- What an invite can and cannot do. It creates an account. It cannot
 * change one: this goes through createUser, which refuses a name that exists,
 * and never through upsertUser, which resets the password of whatever name it
 * is handed. That distinction is the whole security of this route, because an
 * invite code is a far weaker secret than the admin token - it is sent through
 * a messaging app to someone who does not have an account yet. If signup could
 * reach the reset path, anyone holding a spent-looking link could type the
 * operator's own name and a password of their choosing.
 *
 * The order below is claim-then-create for one reason: a name collision is the
 * failure that actually happens, and it has to be recoverable. So the invite is
 * put back if the account cannot be created, and someone who picks a name
 * their friend already took just picks another one instead of going back to
 * the operator for a fresh link.
 */
export async function handleSignup({ request, env }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const { reason } = await checkInvite(env.DB, code);
  // 403 rather than 401: 401 means "authenticate and try again", and there is
  // nothing this caller can retry with. The reason is safe to say out loud -
  // whoever is holding the link already knows they have one, and "expired" and
  // "already used" call for different next steps from them.
  if (reason) return json({ error: reason }, 403);

  if (!name) return json({ error: "name is required" }, 400);
  if (name.length > 60) return json({ error: "name must be 60 characters or fewer" }, 400);
  // The same rule POST /api/users enforces, for the same reason: /api/login has
  // no rate limiting in front of it. Stated in full rather than as "invalid",
  // since this is someone choosing a password right now.
  if (password.length < 12) return json({ error: "password must be at least 12 characters" }, 400);

  if (!(await claimInvite(env.DB, code))) {
    return json({ error: "this invite has already been used" }, 409);
  }

  const user = await createUser(env.DB, name, password);
  if (!user) {
    await releaseInvite(env.DB, code);
    return json({ error: `the name "${name}" is already taken here - pick another` }, 409);
  }
  await recordInviteUse(env.DB, code, user.id);

  const token = await createSession(env.DB, user.id, "browser");
  return json({ token, user: { id: user.id, name: user.name } }, 201);
}

/**
 * POST /api/tokens - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ user, label? }` -> `{ token, user }`.
 *
 * Issues a long-lived session for someone else's account: the credential their
 * scheduled search keeps on disk in `tracker.json`.
 *
 * This route exists because self-signup took the password away from the
 * operator, which was previously how they got this. The old sequence was
 * "create their account with a password you chose, then log in as them once to
 * mint the search's token" - and the first half of that is exactly what
 * /api/signup replaced. Without this route, an account somebody made for
 * themselves could never be given a scheduled search.
 *
 * It grants nothing the admin token did not already have. ADMIN_TOKEN can set
 * any account's password through POST /api/users and then log in as them, so
 * the reach is unchanged; what changes is that doing it no longer destroys the
 * password the person chose. Every token minted here is labelled, so it shows
 * up in that account's session list as what it is rather than as a mystery
 * login they don't remember.
 */
export async function handleMintToken({ request, env }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.user === "string" ? body.user.trim() : "";
  if (!name) return json({ error: "user is required" }, 400);

  const user = await getUserByName(env.DB, name);
  if (!user) return json({ error: `no user named "${name}"` }, 404);

  const label = typeof body.label === "string" && body.label ? body.label : "scheduled-search";
  const token = await createSession(env.DB, user.id, label);
  return json({ token, user: { id: user.id, name: user.name } }, 201);
}
