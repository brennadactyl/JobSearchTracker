/**
 * Who is calling, and are they allowed to. Everything that touches a password
 * or a session token lives here; the route modules and index.js only ever
 * call the four functions at the bottom.
 *
 * The model: a person has a name and a password (users), and holds zero or
 * more bearer tokens (sessions). An invite (invites) is the third credential
 * here and the weakest: it is held by someone who has no account yet, travels
 * through a chat message, and buys exactly one call to POST /api/signup. Passwords are only ever seen by POST
 * /api/login and POST /api/users - every other request carries a token, which
 * is a random 32 bytes with no relationship to the password at all. That's
 * what lets the scheduled searches keep a long-lived credential on disk
 * without that credential being the human's password, and what makes "log this
 * browser out" a row delete instead of a password change.
 *
 * Replaces the old single API_TOKEN worker secret, which was one constant
 * shared by the webpage, every scheduled search, and anyone who had ever been
 * told it - unrevocable except by rotating it everywhere at once.
 *
 * No dependencies: PBKDF2 and getRandomValues are both native to Workers via
 * Web Crypto, so this file adds nothing to install or audit.
 */

// 100k rather than the ~600k OWASP suggests for PBKDF2-SHA256, deliberately:
// this runs inside a Worker request, where CPU time is both metered and
// capped, and a login is already the slowest thing this API does. The
// `iterations` column is stored per user so this can be raised later without
// invalidating anyone's password.
const PBKDF2_ITERATIONS = 100000;
const DERIVED_BITS = 256;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

// Used when no account matches the name given at login - see verifyPassword.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

/** @typedef {{id: string, name: string, password_hash: string, password_salt: string, iterations: number, created_at: string}} User */

// base64url (no padding) rather than plain base64: session tokens travel in an
// Authorization header and get pasted into JSON config files by hand, and '+'
// and '/' are exactly the characters that survive that journey least well.
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Derives the stored form of a password. Pass an existing salt/iterations to
 * re-derive for verification; omit them to mint a new credential.
 * @param {string} password
 * @param {string} [saltB64]
 * @param {number} [iterations]
 * @returns {Promise<{hash: string, salt: string, iterations: number}>}
 */
export async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? fromBase64(saltB64) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    DERIVED_BITS
  );
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt), iterations };
}

// Compares every byte regardless of where the first mismatch is, so how long
// the comparison takes doesn't leak how much of the hash was guessed right.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {string} password
 * @param {User} user
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, user) {
  // An empty stored hash means login is disabled (the state the migration's
  // backfill row starts in, before POST /api/users sets a real password). Fail
  // closed rather than treating "no password" as "any password".
  //
  // Derive anyway before failing. Returning early here would make a login for
  // a name that doesn't exist measurably faster than one with a wrong
  // password - ~15ms against ~48ms, trivially separable over the network -
  // which hands out exactly the "does this person have an account here?"
  // answer that the identical error message is there to withhold.
  if (!user || !user.password_hash || !user.password_salt) {
    await hashPassword(password, DUMMY_SALT, PBKDF2_ITERATIONS);
    return false;
  }
  const { hash } = await hashPassword(password, user.password_salt, user.iterations || PBKDF2_ITERATIONS);
  return timingSafeEqual(hash, user.password_hash);
}

/**
 * A new opaque credential - 32 random bytes, base64url. Both kinds of bearer
 * string this API hands out come from here: the session token a browser or a
 * scheduled search carries, and the invite code that buys one signup. They are
 * the same thing structurally (unguessable, meaningless, stored only as a
 * hash), so they are minted the same way rather than by two generators that
 * could drift to different lengths.
 * @returns {string}
 */
export function newOpaqueToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * What actually goes in `sessions.id` - and in `invites.id`. The credential
 * itself is never stored, in either table: 32
 * random bytes need no salt or stretching to be unguessable, but storing them
 * as-is would mean a `d1 export`, a backup file, or the audit query in the
 * README each hand over working credentials for every signed-in device. A
 * plain SHA-256 costs one hash per request and makes the stored row useless
 * to anyone who reads it. An unused invite code is the same kind of secret as
 * a live session - it creates an account - so it gets the same treatment.
 * @param {string} token
 * @returns {Promise<string>}
 */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64(new Uint8Array(digest));
}

/** Pulls the bearer token out of a request, or "" if there isn't one. */
export function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Resolves a bearer token to the person holding it. This is the whole access
 * check for every route except login and user provisioning - there is no
 * separate "is this token valid" step, because a token that doesn't join to a
 * user simply isn't one.
 * @param {D1Database} d1
 * @param {string} token
 * @returns {Promise<{id: string, name: string, session_id: string}|null>}
 */
export async function getSessionUser(d1, token) {
  if (!token) return null;
  const row = await d1
    .prepare(
      `SELECT u.id AS id, u.name AS name, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .bind(await hashToken(token))
    .first();
  return row || null;
}

/** @param {D1Database} d1 @param {string} name @returns {Promise<User|null>} */
export async function getUserByName(d1, name) {
  const row = await d1.prepare("SELECT * FROM users WHERE name = ?").bind(name).first();
  return row || null;
}

/**
 * Issues a session. `label` is free text describing where the token will live
 * ('browser', 'scheduled-search'), so a credential can later be revoked by
 * what it is rather than by guessing which opaque string is which.
 * @param {D1Database} d1
 * @param {string} userId
 * @param {string} label
 * @returns {Promise<string>} the new token
 */
export async function createSession(d1, userId, label) {
  const token = newOpaqueToken();
  await d1
    .prepare("INSERT INTO sessions (id, user_id, created_at, label) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, new Date().toISOString(), (label || "browser").slice(0, 60))
    .run();
  // The only time the token itself exists anywhere; the row holds its hash.
  return token;
}

/** @param {D1Database} d1 @param {string} token @returns {Promise<boolean>} */
export async function deleteSession(d1, token) {
  const result = await d1.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashToken(token)).run();
  return result.meta.changes > 0;
}

/**
 * Creates a user, or sets an existing one's password. Both halves are the same
 * operation on purpose: nothing else in the system can run PBKDF2, so if this
 * route couldn't overwrite a password there would be no way to reset one
 * short of hand-deriving a hash offline. Creating never touches an existing
 * id, so a password change leaves every row that references the user alone.
 * @param {D1Database} d1
 * @param {string} name
 * @param {string} password
 * @returns {Promise<{id: string, name: string, created: boolean}>}
 */
export async function upsertUser(d1, name, password) {
  const { hash, salt, iterations } = await hashPassword(password);
  const existing = await getUserByName(d1, name);
  if (existing) {
    await d1
      .prepare("UPDATE users SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ?")
      .bind(hash, salt, iterations, existing.id)
      .run();
    return { id: existing.id, name: existing.name, created: false };
  }
  const id = crypto.randomUUID();
  await d1
    .prepare(
      `INSERT INTO users (id, name, password_hash, password_salt, iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, name, hash, salt, iterations, new Date().toISOString().slice(0, 10))
    .run();
  return { id, name, created: true };
}

/**
 * Creates a user, and refuses if that name is taken. The other half of
 * upsertUser above, deliberately split from it rather than added as a flag.
 *
 * upsertUser doubles as password reset, which is right for the route that
 * holds the ADMIN_TOKEN and wrong for every other caller: an invite code
 * travels through a chat message, and if signup went through upsertUser then
 * anyone holding one could take over an existing account by typing that
 * person's name and a password of their choosing. The refusal is the whole
 * point of the function, so it is the function, not an argument someone can
 * forget to pass.
 *
 * The pre-check and the catch are both needed. `users.name` is UNIQUE COLLATE
 * NOCASE, so the database is the real guard against two accounts differing
 * only in case; the lookup first is what turns the common case - a name
 * someone else already picked - into a clean answer rather than a constraint
 * error to interpret.
 *
 * @param {D1Database} d1
 * @param {string} name
 * @param {string} password
 * @returns {Promise<{id: string, name: string}|null>} null if the name is taken
 */
export async function createUser(d1, name, password) {
  if (await getUserByName(d1, name)) return null;
  const { hash, salt, iterations } = await hashPassword(password);
  const id = crypto.randomUUID();
  try {
    await d1
      .prepare(
        `INSERT INTO users (id, name, password_hash, password_salt, iterations, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, name, hash, salt, iterations, new Date().toISOString().slice(0, 10))
      .run();
  } catch {
    // Lost a race with another signup for the same name. Same answer as the
    // pre-check gives, so the caller has one case to handle, not two.
    return null;
  }
  return { id, name };
}

// 14 days. Long enough that a link sent on a Friday still works after someone
// gets back to it the following weekend, short enough that a code sitting in a
// year-old chat thread is not a live way into this deployment.
const INVITE_DAYS = 14;

/**
 * Mints an invite. Returns the code exactly once - it is never stored, only
 * its hash - so the caller either sends it now or mints another.
 *
 * @param {D1Database} d1
 * @param {string} note the operator's own words about who this is for
 * @param {number} [days]
 * @returns {Promise<{code: string, expires_at: string}>}
 */
export async function createInvite(d1, note, days = INVITE_DAYS) {
  const code = newOpaqueToken();
  const now = new Date();
  const expires = new Date(now.getTime() + days * 86400000).toISOString();
  await d1
    .prepare("INSERT INTO invites (id, note, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(code), (note || "").slice(0, 200), now.toISOString(), expires)
    .run();
  return { code, expires_at: expires };
}

/**
 * Why an invite can't be used, or "" if it can. One function so the check
 * before the form is drawn and the check at signup can never disagree - which
 * is the failure that would matter here: a page that offers a signup form for
 * a dead code, and only says so after someone has chosen a password.
 *
 * @param {D1Database} d1
 * @param {string} code
 * @returns {Promise<{row: Object|null, reason: string}>}
 */
export async function checkInvite(d1, code) {
  if (!code) return { row: null, reason: "no invite code" };
  const row = await d1.prepare("SELECT * FROM invites WHERE id = ?").bind(await hashToken(code)).first();
  if (!row) return { row: null, reason: "this invite link isn't valid" };
  if (row.used_at) return { row, reason: "this invite has already been used" };
  if (row.expires_at < new Date().toISOString()) return { row, reason: "this invite link has expired" };
  return { row, reason: "" };
}

/**
 * Takes the invite out of circulation, and reports whether this caller is the
 * one who got it. The `WHERE used_at = ''` is what makes that true: two
 * signups arriving together both read an unused row above, and exactly one of
 * them changes it here.
 *
 * @param {D1Database} d1
 * @param {string} code
 * @returns {Promise<boolean>} false if someone else claimed it first
 */
export async function claimInvite(d1, code) {
  const result = await d1
    .prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at = ''")
    .bind(new Date().toISOString(), await hashToken(code))
    .run();
  return result.meta.changes === 1;
}

/**
 * Puts a claimed invite back, for the one case that happens in practice: the
 * claim succeeded and then the account couldn't be created because the name
 * was taken. Burning someone's only invite over a name collision would mean
 * going back to the operator for a new link - which is the errand this whole
 * feature exists to remove.
 *
 * @param {D1Database} d1
 * @param {string} code
 */
export async function releaseInvite(d1, code) {
  await d1.prepare("UPDATE invites SET used_at = '' WHERE id = ?").bind(await hashToken(code)).run();
}

/**
 * Records which account an invite produced. Separate from the claim because
 * the claim has to happen before the user exists to name.
 *
 * @param {D1Database} d1
 * @param {string} code
 * @param {string} userId
 */
export async function recordInviteUse(d1, code, userId) {
  await d1.prepare("UPDATE invites SET used_by = ? WHERE id = ?").bind(userId, await hashToken(code)).run();
}

/**
 * Every invite, newest first, with the account each one produced. This is how
 * the operator answers "has Sam signed up yet, and what is their user id?" -
 * and that id is the next thing they need, since it names the folder their
 * search data lives in.
 *
 * Never returns a code, because it cannot: the codes were never stored.
 *
 * @param {D1Database} d1
 * @returns {Promise<Object[]>}
 */
export async function listInvites(d1) {
  const { results } = await d1
    .prepare(
      `SELECT i.note, i.created_at, i.expires_at, i.used_at, i.used_by, u.name AS used_by_name
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC`
    )
    .all();
  return results || [];
}
