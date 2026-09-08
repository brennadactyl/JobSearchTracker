/**
 * Invites: the one-time codes that let someone create their own account.
 *
 * The signup they lead to is not here - it is in ./accounts.js, with the other
 * two handlers a password reaches, so that file stays the single place to look
 * for anything that touches one. What lives here is the operator's half
 * (minting a code, seeing which ones have been used) and the one public read
 * the page makes before it draws a signup form.
 *
 * Why any of this exists: creating an account used to require the ADMIN_TOKEN,
 * which meant it could only be done by the person holding the deployment - who
 * therefore had to choose someone else's password and send it to them. An
 * invite moves that whole step to the person it is about. The operator pastes
 * one link and is finished.
 *
 * These take a raw `env.DB` rather than a scoped `Db` for the same reason
 * ./accounts.js does: an invite belongs to nobody yet. See ../auth.js for the
 * table access itself, which sits with sessions and passwords because an
 * invite is a credential like they are.
 */

import { checkInvite, createInvite, listInvites } from "../auth.js";
import { json, readJson } from "../http.js";
import { notAdmin } from "../validate.js";

// A month is already longer than any invite should need to live, and the cap
// is here so a typo in `days` can't mint a code that outlives the deployment.
const MAX_INVITE_DAYS = 30;

/**
 * POST /api/invites - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ note?, days? }` -> `{ code, expires_at }`.
 *
 * Mints a code and returns it **once**. Only its hash is stored (see
 * ../auth.js's hashToken), so there is no route that can show it again and no
 * backup file that leaks it - a lost code is re-minted, not recovered.
 *
 * `note` is the operator's own shorthand for who it was for. It never reaches
 * the person holding the code: they see a signup form, not somebody's private
 * note about them.
 */
export async function handleCreateInvite({ request, env }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const note = typeof body.note === "string" ? body.note : "";
  const asked = Number(body.days);
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_INVITE_DAYS) : undefined;

  const invite = await createInvite(env.DB, note, days);
  return json(invite, 201);
}

/**
 * GET /api/invites - requires the ADMIN_TOKEN secret as Bearer -> `{ invites }`.
 *
 * Every invite ever minted, newest first, and what became of it. This is how
 * the operator answers "has Sam signed up yet?" without opening D1 - and, more
 * usefully, how they get the **user id** a signup produced, which is the name
 * of the folder that person's search data will live in.
 *
 * No codes in the response; there are none stored to return.
 */
export async function handleListInvites({ request, env }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;
  return json({ invites: await listInvites(env.DB) });
}

/**
 * GET /api/invite/:code - public -> `{ valid: true }` or `{ valid: false, reason }`.
 *
 * Asked by the page as soon as someone opens an invite link, so a dead link
 * says so on arrival instead of after they have thought up a name and typed a
 * password twice. Singular path on purpose - `/api/invites` is the operator's
 * listing and this is one specific code; the same word for both would put a
 * public route one missing gate away from the admin one.
 *
 * Answering "no, and here is why" to an unauthenticated caller is fine: the
 * codes are 32 random bytes, so there is nothing to enumerate, and the person
 * asking is holding the link already. What it never returns is the note, or
 * anything about the account a used invite created.
 */
export async function handleCheckInvite({ env, params }) {
  const { reason } = await checkInvite(env.DB, params[0] || "");
  return reason ? json({ valid: false, reason }) : json({ valid: true });
}
