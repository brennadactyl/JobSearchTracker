/**
 * The company rotation: which companies a search tracks, when each was last
 * attempted, and the slice a given run is told to cover tonight.
 *
 * The rotation's whole job is to stop a run starting at the top of the list
 * every night - a list too long to verify in one go gets covered a batch at a
 * time, least-recently-swept first.
 */

import { json, readJson } from "../http.js";
import { excluderFor, isoDate, today, unknownTrack } from "../validate.js";

// How many companies one run covers. A whole list is more than a run can
// verify properly, and the failure isn't that a company gets missed - it's
// that all of them get skimmed. Twelve is the number that keeps a list the
// size these actually are (35-60) inside a week's cycle while leaving a run's
// budget for what it's for: opening every candidate posting and confirming it
// renders a real job description.
//
// A constant, not config: nobody has wanted a different number, and a setting
// nobody sets is a setting that goes stale. It moves here the day someone does.
export const COVERAGE_BATCH = 12;

/**
 * GET /api/coverage/:key - requires a Bearer token ->
 * `{ companies: [{company, last_swept, board, note}], total, batch }`.
 *
 * Which companies this run covers, chosen by the server. Least-recently-swept
 * first, capped - the run is told what to sweep rather than how to choose,
 * because a cap in prose is a cap a run can talk itself out of on a night when
 * the list looks short. `?all=1` returns the whole table instead, for seeding
 * and for looking at it.
 *
 * Same 404-on-unknown-track reasoning as the dedup route (see ./screened.js):
 * an empty list from a mistyped key would read as "nothing to sweep", and a
 * run would quietly search nothing at all.
 */
export async function handleGetCoverage({ db, params, url }) {
  const key = params[0];
  const all = url.searchParams.get("all") === "1";
  if (!(await db.trackExists(key))) return unknownTrack(key);
  // Filtered on the way out as well as on the way in, because the two catch
  // different things. recordSweeps refuses to *add* an excluded company; this
  // refuses to hand back one that is already in the table - which is the
  // ordinary case, not the exotic one. An exclusion usually gets added because
  // the person saw a posting and decided never again, so the company is
  // already in the rotation by the time it lands on the list. Guarding only
  // the write would leave it being served as a company to cover, every cycle,
  // for as long as the row exists.
  //
  // Filtered rather than deleted: the row is the rotation's memory of when
  // that company was last looked at, the exclusion list is editable, and
  // reading is the wrong moment to destroy data.
  const [companies, total] = await Promise.all([
    db.getCoverage(key, 0),
    db.countCoverage(key),
  ]);
  const isExcluded = await excluderFor(db);
  const allowed = companies.filter((c) => !isExcluded(c.company));

  // Companies the rotation already knows it cannot read are skipped until
  // their block expires, and the batch is filled from the next eligible ones
  // instead. Every company in a slice is a slot a run spends, and a slot spent
  // on a domain that has refused automated fetches for nine days running buys
  // nothing - on 2026-09-03 four of twelve went that way and the day yielded
  // one lead. Skipping them is only half the value; topping up is the other
  // half, or the run just covers eight companies instead of twelve.
  //
  // `?all=1` deliberately still shows them. That view is for seeding and for
  // looking at the table, and a blocked company hidden from the only view that
  // shows the whole rotation is one nobody can find to unblock.
  const now = today();
  const eligible = all ? allowed : allowed.filter((c) => !(c.blocked_until > now));
  const blocked = allowed.length - eligible.length;

  // The cap is applied after both filters, so neither an excluded nor a
  // blocked company can eat a slot in the batch a run is told to cover.
  const batch = all ? eligible.length : COVERAGE_BATCH;
  return json({
    companies: eligible.slice(0, batch),
    total: eligible.length,
    batch,
    // Reported so a run can say "twelve covered, three others are on
    // cooldown" rather than the rotation quietly shrinking with no explanation
    // of where the rest went.
    blocked,
  });
}

// How long a company stays out of the rotation after a run could not read it,
// by consecutive failure. Escalating rather than flat: a fixed retry still
// spends a slot every cycle forever on a domain that has refused every attempt
// for over a week, which is most of the cost this exists to remove. Capped, so
// a company is never blocked for good - boards get unblocked, ATS migrations
// finish, and the rotation should find out.
//
// Here rather than in the prompt, for the same reason the delisting policy is:
// a cadence a run decides for itself is one that drifts and cannot be tested.
// The run reports only whether it could read the company.
const BACKOFF_DAYS = [3, 7, 14, 28];

function backoffDays(streak) {
  return BACKOFF_DAYS[Math.min(Math.max(streak, 1), BACKOFF_DAYS.length) - 1];
}

/** @param {string} from YYYY-MM-DD @param {number} days @returns {string} YYYY-MM-DD */
function addDays(from, days) {
  const t = Date.parse(from + "T00:00:00Z");
  if (isNaN(t)) return "";
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/**
 * POST /api/coverage - requires a Bearer token. Body
 * `{ search, on?, swept: [{company, board?, note?}] }`.
 *
 * Records what a run actually attempted. Attempted, not found: a company whose
 * board was blocked today still gets stamped, or the rotation retries it every
 * run forever and the rest of the list starves. Creates rows it hasn't seen,
 * so a company broader discovery turned up joins the rotation by being swept
 * once.
 */
export async function handleRecordSweeps({ request, db }) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);
  if (!(await db.trackExists(key))) return unknownTrack(key);

  const incoming = Array.isArray(body.swept) ? body.swept : [];
  const valid = incoming
    .filter((i) => i && typeof i.company === "string" && i.company.trim())
    .map((i) => ({ ...i, company: i.company.trim() }));
  if (valid.length === 0) return json({ error: "no companies provided" }, 400);

  // Same reasoning as /api/runs: the worker only knows UTC, and a 01:00 local
  // run is already the next UTC day - a date derived here would stamp tomorrow.
  // An explicit "" is not a malformed date, it's "register these companies,
  // I haven't swept them" - the seeding case, which must not stamp anything
  // (see db.recordSweeps).
  const on = body.on === "" ? "" : isoDate(body.on) || today();

  // The rotation is the surface where an exclusion would become permanent.
  // This route creates a row for any company it is handed - that is how a
  // company broader discovery turned up joins the rotation - so an excluded
  // company swept once would be stored, then handed back by
  // GET /api/coverage as a company to cover, every cycle, forever. Every other
  // exclusion leak is one row; this one is self-renewing.
  const isExcluded = await excluderFor(db);
  const allowed = valid.filter((i) => !isExcluded(i.company));
  const excluded = valid.length - allowed.length;
  if (allowed.length === 0) return json({ recorded: 0, excluded, on });

  // `unreadable` is the run reporting a fact about tonight: it tried and got
  // nothing usable back - a blocked domain, ids that all 404, a board whose
  // filtering turned out to be client-side. It is NOT "searched fine, nothing
  // matched", which is an ordinary covered sweep and by far the common case.
  //
  // What that fact is worth is decided here. A company that failed gets a
  // lengthening block; one that worked has its block and streak cleared
  // outright, so a brief outage costs three days rather than a sentence.
  const existing = new Map(
    (await db.getCoverage(key, 0)).map((c) => [c.company, c])
  );
  const stamped = allowed.map((i) => {
    const unreadable = i.unreadable === true;
    if (!unreadable) return { ...i, blockedUntil: "", failStreak: 0 };
    const prior = existing.get(i.company);
    const streak = (prior && Number(prior.fetch_fail_streak)) || 0;
    const next = streak + 1;
    return {
      ...i,
      failStreak: next,
      // Dated from the sweep date, not from the worker's clock - `on` is the
      // run's own local date and is what `last_swept` gets, so a block that
      // counted from anything else could expire before the day it started.
      blockedUntil: addDays(on || today(), backoffDays(next)),
    };
  });

  const recorded = await db.recordSweeps(key, stamped, on);
  const blocked = stamped.filter((i) => i.blockedUntil).length;
  return json({ recorded, excluded, blocked, on });
}
