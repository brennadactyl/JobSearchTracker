/**
 * Intake: someone describing the job search they want, in their own words, for
 * a run to build later.
 *
 * ---- Why this is a queue and not a form that writes config.
 *
 * What /api/config stores is finished prose - the sentence the daily prompt
 * reads verbatim ("Senior/Staff Software Engineer, Backend Engineer, or
 * Distributed Systems roles"), a geographic scope written out with worked
 * examples of what it excludes, a resume instruction naming a specific file
 * and its fallback. None of that is a thing to ask a person for directly. What
 * they can tell you is "senior backend, ideally Seattle or remote in the US,
 * not London", and turning the second into the first is the job the
 * job-search-setup skill has always done.
 *
 * So the form collects the second, and a nightly run does the turning. That
 * split is what makes self-service possible at all: the interview stops being
 * something the operator has to sit in and relay, and becomes a row.
 *
 * There is a second, harder reason. A resume has to reach the machine that
 * will run the search, and the person uploading it is not sitting at that
 * machine. Nothing else in this API moves a file; this does, for exactly that
 * hop, and deletes it as soon as the hop is made (see db.js's completeIntake).
 *
 * ---- Two audiences, one table. The four session routes are the person's own:
 * submit, check status, attach a document, remove one. The three admin routes
 * are the operator's queue - every intake waiting across the whole deployment,
 * which is not any one person's data and so is not reachable with any session
 * token, only with the ADMIN_TOKEN the operator's machine holds.
 *
 * See ../../migrations/0011_intake.sql for the table, and ../db.js for the
 * queries.
 */

import { getUserByName } from "../auth.js";
import { Db } from "../db.js";
import { json, readJson } from "../http.js";
import { notAdmin } from "../validate.js";

// The whole answers object, serialised. Generous because `resume_text` is in
// here - someone pasting a long CV should not be told to trim it - and capped
// because this is a single D1 value, where the hard ceiling is 1,000,000 bytes.
const MAX_ANSWERS_BYTES = 120000;

// Decoded upload size. base64 inflates by a third, so 700KB of file is ~933KB
// stored, which is the most that fits under D1's per-value limit with room to
// spare. A resume is tens of kilobytes; anything approaching this is a scanned
// image of one, and the run would not be able to read it anyway.
const MAX_FILE_BYTES = 700000;

// Enough for a resume, a cover letter, and a couple of things they thought
// were relevant. Not a document store.
const MAX_FILES = 5;

// What a run will actually be able to read on the other end. `.docx` is
// accepted and deliberately last in the list: a headless run often cannot
// extract text from one, which is why the form asks for pasted text as well
// and why the setup skill's `resume_line` is told to name a fallback.
const ALLOWED_EXTENSIONS = ["pdf", "txt", "md", "rtf", "doc", "docx"];

/**
 * A filename safe to write to disk on somebody else's machine.
 *
 * This matters more here than anywhere else in the API. Every other string a
 * caller sends ends up in a database column; this one ends up as a **path** on
 * the operator's computer, created by an overnight run with no one watching.
 * So the name is not sanitised so much as rebuilt: the basename only (both
 * separators, because the uploader may be on either kind of system), then
 * every character outside a small allowlist replaced, then leading dots
 * dropped so nothing can be relative.
 *
 * @param {string} raw
 * @returns {string} a plain filename, or "" if nothing usable was left
 */
export function safeFilename(raw) {
  const base = String(raw || "").split(/[/\\]/).pop() || "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 100);
  if (!cleaned || !cleaned.includes(".")) return "";
  const ext = cleaned.split(".").pop().toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) ? cleaned : "";
}

/**
 * Decoded byte length of a base64 string, or -1 if it isn't one.
 *
 * Computed by decoding rather than from the length, because the length only
 * tells you what a *valid* payload would weigh - and the thing actually worth
 * refusing here is a body that isn't base64 at all, which would otherwise be
 * stored happily and fail on the machine trying to write it out, hours later,
 * with nobody there to read the error.
 *
 * @param {string} b64
 * @returns {number}
 */
function decodedBytes(b64) {
  try {
    return atob(b64).length;
  } catch {
    return -1;
  }
}

/**
 * The answers, checked only where a run would otherwise be left with nothing
 * to act on. Everything else is free text and stays free text: this is an
 * interview, and refusing an answer because it was phrased unexpectedly is the
 * failure mode worth avoiding.
 *
 * @param {Object} body
 * @returns {{answers: Object}|{error: string}}
 */
function readAnswers(body) {
  const tracksIn = Array.isArray(body.tracks) ? body.tracks : [];
  const tracks = tracksIn
    .map((t) => ({
      label: String(t && t.label ? t.label : "").trim().slice(0, 60),
      role_search_line: String(t && t.role_search_line ? t.role_search_line : "").trim().slice(0, 1000),
      target_companies: String(t && t.target_companies ? t.target_companies : "").trim().slice(0, 4000),
      fit_note: String(t && t.fit_note ? t.fit_note : "").trim().slice(0, 1000),
      // "this is a second tab on that track's search, not a search of its own"
      // - the label of the track it splits from, resolved to a `fed_by` key by
      // the run, which is what assigns the keys in the first place.
      feeds_from: String(t && t.feeds_from ? t.feeds_from : "").trim().slice(0, 60),
    }))
    .filter((t) => t.label && t.role_search_line);

  if (tracks.length === 0) {
    return { error: "describe at least one kind of role you want searched for" };
  }

  const answers = {
    display_title: String(body.display_title || "").trim().slice(0, 120),
    pronouns: String(body.pronouns || "").trim().slice(0, 40),
    geo_scope: String(body.geo_scope || "").trim().slice(0, 2000),
    priority_locations: String(body.priority_locations || "").trim().slice(0, 2000),
    excluded_companies: String(body.excluded_companies || "").trim().slice(0, 2000),
    resume_text: String(body.resume_text || "").trim().slice(0, 100000),
    notes: String(body.notes || "").trim().slice(0, 4000),
    tracks,
  };

  if (JSON.stringify(answers).length > MAX_ANSWERS_BYTES) {
    return { error: "that's more than this form can store - try trimming the pasted resume text" };
  }
  return { answers };
}

/**
 * GET /api/intake - session -> `{ intake }` or `{ intake: null }`.
 *
 * What the page asks on load to decide whether to show the setup form, a
 * "we're building this tonight" note, or the tracker itself. A brand-new
 * account has no config and no intake, which is the only state that means
 * "show them the form".
 */
export async function handleGetIntake({ db }) {
  return json({ intake: await db.getIntake() });
}

/**
 * POST /api/intake - session. Body is the answers object -> `{ ok, status }`.
 *
 * Re-submitting while still pending replaces the previous answers, deliberately
 * (see db.js's setIntake). Re-submitting after a run has finished does not:
 * once someone has tracks, a folder and a schedule, this form is no longer the
 * thing that changes their search - their config is, and re-running setup from
 * a form would quietly overwrite whatever they have since edited on the page.
 */
export async function handleSubmitIntake({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const existing = await db.getIntake();
  if (existing && existing.status === "done") {
    return json(
      { error: "your search is already set up - change it from the tracker rather than through setup" },
      409
    );
  }

  const read = readAnswers(body);
  if (read.error) return json({ error: read.error }, 400);

  await db.setIntake(read.answers);
  return json({ ok: true, status: "pending" }, 201);
}

/**
 * POST /api/intake/files - session. Body `{ filename, contentType?, body }`
 * where `body` is base64 -> `{ id, filename, bytes }`.
 *
 * The resume, on its way to a machine its owner has never touched. JSON and
 * base64 rather than multipart, because every other route in this worker takes
 * JSON and a second body format is a second thing to get right for the sake of
 * saving a third of the bytes on a file measured in tens of kilobytes.
 */
export async function handleUploadIntakeFile({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const existing = await db.getIntake();
  if (existing && existing.status === "done") {
    return json({ error: "your search is already set up - there's nothing left to attach it to" }, 409);
  }
  if (existing && existing.files.length >= MAX_FILES) {
    return json({ error: `that's the ${MAX_FILES}-document limit - remove one first` }, 409);
  }

  const filename = safeFilename(body.filename);
  if (!filename) {
    return json(
      { error: `name that file with one of these endings: ${ALLOWED_EXTENSIONS.map((e) => "." + e).join(", ")}` },
      400
    );
  }

  const encoded = typeof body.body === "string" ? body.body.replace(/^data:[^,]*,/, "") : "";
  const bytes = decodedBytes(encoded);
  if (bytes <= 0) return json({ error: "that file didn't arrive readable - try attaching it again" }, 400);
  if (bytes > MAX_FILE_BYTES) {
    return json({ error: `that file is larger than ${Math.floor(MAX_FILE_BYTES / 1000)}KB` }, 413);
  }

  const id = await db.addIntakeFile({
    filename,
    contentType: String(body.contentType || "").slice(0, 100),
    bytes,
    body: encoded,
  });
  return json({ id, filename, bytes }, 201);
}

/**
 * POST /api/intake/files/delete - session. Body `{ id }` -> `{ ok }`.
 *
 * A POST rather than a DELETE because this worker's CORS preflight advertises
 * `GET, POST, OPTIONS` (see ../http.js) and a fourth method would have to be
 * added there for one route.
 *
 * The scoped `Db` is the whole access check: another person's file id doesn't
 * match, so it reports the same "not yours" as an id that never existed.
 */
export async function handleDeleteIntakeFile({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "id is required" }, 400);
  const removed = await db.deleteIntakeFile(id);
  return removed ? json({ ok: true }) : json({ error: "no such attachment" }, 404);
}

/**
 * GET /api/intake/pending - requires the ADMIN_TOKEN secret as Bearer ->
 * `{ pending: [...] }`.
 *
 * The operator's queue: everyone across the deployment waiting to be set up,
 * plus everyone whose setup failed and is worth another try. Oldest first, so
 * a run that can only get through some of them does the longest-waiting.
 *
 * Admin-gated rather than session-gated because it is inherently cross-user -
 * there is no "caller" whose rows these are. It is the one route the nightly
 * onboarding run needs before it has any person's token, and the reason that
 * run holds the admin secret at all.
 *
 * Attachments are listed but not included; fetch each from the route below.
 */
export async function handleGetIntakeQueue({ request, env }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;
  return json({ pending: await Db.pendingIntakes(env.DB) });
}

/**
 * GET /api/intake/file/:id - requires the ADMIN_TOKEN secret as Bearer ->
 * `{ id, filename, content_type, bytes, body }`, `body` base64.
 *
 * One document, for the run to write into that person's `resumes/` folder.
 * Fetched one at a time so a queue listing stays small enough to read.
 */
export async function handleGetIntakeFile({ request, env, params }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;
  const file = await Db.intakeFile(env.DB, Number(params[0]));
  if (!file) return json({ error: "no such attachment" }, 404);
  return json({
    id: file.id,
    user_id: file.user_id,
    filename: file.filename,
    content_type: file.content_type,
    bytes: file.bytes,
    body: file.body,
  });
}

/**
 * POST /api/intake/complete - requires the ADMIN_TOKEN secret as Bearer. Body
 * `{ user, status, note? }` -> `{ ok, status }`.
 *
 * How a run closes an intake out. `done` on success, which also deletes the
 * uploaded documents - the copy in D1 exists only for the trip from browser to
 * disk, and that trip is now over.
 *
 * `failed` leaves them, because a failure is retried and the retry will need
 * them. `note` is what went wrong, in words the person will read on their own
 * page: they are waiting on a setup that isn't coming, and the difference
 * between "we couldn't read your resume file, please paste the text instead"
 * and silence is the difference between them fixing it tonight and them
 * assuming the whole thing is broken.
 *
 * Names its subject in the body, like /api/purge, and builds its own `Db` for
 * that person rather than being handed one.
 */
export async function handleCompleteIntake({ request, env }) {
  const denied = notAdmin(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const name = typeof body.user === "string" ? body.user.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!name) return json({ error: "user is required" }, 400);
  if (status !== "done" && status !== "failed") {
    return json({ error: 'status must be "done" or "failed"' }, 400);
  }

  const user = await getUserByName(env.DB, name);
  if (!user) return json({ error: `no user named "${name}"` }, 404);

  const db = new Db(env.DB, user.id);
  if (!(await db.getIntake())) return json({ error: `${user.name} has no setup waiting` }, 404);

  await db.completeIntake(status, typeof body.note === "string" ? body.note : "");
  return json({ ok: true, status });
}
