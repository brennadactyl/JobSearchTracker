/**
 * Who is calling: exchanging a password for a token, giving one back, saying
 * who a token belongs to, and provisioning the people who hold them.
 *
 * ---- Auth. A person has a name and a password; they hold bearer tokens
 * (sessions). Passwords are seen by exactly three handlers in this whole
 * codebase, and all three are here - login, admin provisioning, and a person
 * changing their own - every other route resolves a token to a user
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
  deleteOtherBrowserSessions,
  deleteSession,
  getUserById,
  getUserByName,
  setUserPassword,
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

/**
 * POST /api/password - requires a Bearer token. Body
 * `{ currentPassword, newPassword, signOutOthers? }` -> `{ ok, signedOut }`.
 *
 * Lets a person change their own password, which until now nothing could do.
 * The only route that could set one was POST /api/users, which takes the
 * deployment's ADMIN_TOKEN - so changing a password meant asking the operator,
 * or having the repo, the admin secret and a terminal (scripts/set-password.ps1).
 * Neither is a thing to need in order to rotate your own credential, and the
 * second hands out a secret that can rewrite *any* account's password to
 * someone who only wanted to change their own.
 *
 * ---- The current password is required, and that is the point of the route.
 *
 * The session token alone is not enough. A token that has been copied off a
 * shared machine already reads and writes this person's data, which is bad and
 * recoverable - they can log out everywhere. If that same token could also set
 * the password, it would be an upgrade from "someone has your data" to
 * "someone has your account and you don't", which is not. So this asks for
 * something the token holder is not assumed to have.
 *
 * Told apart from the 12-character rule in the reply, unlike /api/login's
 * deliberately ambiguous refusal: there is nothing to withhold from a caller
 * who is already authenticated as this person, and "wrong current password"
 * and "new one is too short" need different corrections.
 *
 * ---- What survives it.
 *
 * Sessions, by default - the same promise POST /api/users makes. The one that
 * matters is the long-lived token a scheduled search keeps on disk: a password
 * change that killed it would stop that person's nightly search silently, and
 * a search that never fired is indistinguishable from one that found nothing.
 * They would find out weeks later from an empty tab.
 *
 * `signOutOthers` is the opt-in for the case where that isn't what you want -
 * you are changing it *because* something is wrong - and it takes only
 * sessions labelled 'browser' (see deleteOtherBrowserSessions). It defaults to
 * false when the field is absent, so a scripted caller never gets a
 * revocation it did not ask for; the page sends it explicitly either way.
 */
export async function handleChangePassword({ request, env, user, token }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return json({ error: "currentPassword and newPassword are both required" }, 400);
  }
  // The same rule /api/users and the signup path enforce, and for the same
  // reason: /api/login has no rate limiting in front of it, so length is the
  // defence. Checked before the current password is verified so the two
  // messages can't be read as one another.
  if (newPassword.length < 12) {
    return json({ error: "your new password must be at least 12 characters" }, 400);
  }
  if (newPassword === currentPassword) {
    // Almost always a mis-fill rather than an intention. Succeeding silently
    // would leave them believing they had changed something.
    return json({ error: "that's the password you already have" }, 400);
  }

  // By id, from the session. Re-looking-up by name would work today and would
  // be a lookup that can miss the moment a name becomes editable.
  const stored = await getUserById(env.DB, user.id);
  if (!(await verifyPassword(currentPassword, stored))) {
    return json({ error: "that isn't your current password" }, 403);
  }

  await setUserPassword(env.DB, user.id, newPassword);

  const signedOut = body.signOutOthers === true
    ? await deleteOtherBrowserSessions(env.DB, user.id, token)
    : 0;

  return json({ ok: true, signedOut });
}
