/**
 * Who is calling, and are they allowed to. Everything that touches a password
 * or a session token lives here; api.js and index.js only ever call the four
 * functions at the bottom.
 *
 * The model: a person has a name and a password (users), and holds zero or
 * more bearer tokens (sessions). Passwords are only ever seen by POST
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

const PBKDF2_ITERATIONS = 100000;
const DERIVED_BITS = 256;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

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
  if (!user || !user.password_hash || !user.password_salt) return false;
  const { hash } = await hashPassword(password, user.password_salt, user.iterations || PBKDF2_ITERATIONS);
  return timingSafeEqual(hash, user.password_hash);
}

/** @returns {string} a new bearer token - 32 random bytes, base64url */
export function newSessionToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
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
    .bind(token)
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
  const token = newSessionToken();
  await d1
    .prepare("INSERT INTO sessions (id, user_id, created_at, label) VALUES (?, ?, ?, ?)")
    .bind(token, userId, new Date().toISOString(), (label || "browser").slice(0, 60))
    .run();
  return token;
}

/** @param {D1Database} d1 @param {string} token @returns {Promise<boolean>} */
export async function deleteSession(d1, token) {
  const result = await d1.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
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
