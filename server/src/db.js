/**
 * The one place that knows this is D1 (SQLite). Every `env.DB.prepare(...)`
 * call for a user's own data lives here - api.js and index.js never touch D1
 * directly for it, only Db's methods below. That's the point: if this ever
 * needs to run on a different database, only this file changes. The rest of
 * the codebase (request parsing, validation, deciding *when* something
 * happens) doesn't know or care what's storing the rows.
 *
 * ---- Every instance belongs to one user. `new Db(env.DB, userId)` binds the
 * repository to whoever is making the request, and every statement below
 * filters on `this.userId`. That is deliberately not a per-method parameter:
 * with a parameter, forgetting one argument at one call site silently returns
 * (or overwrites) another person's rows, and nothing about the code would look
 * wrong. Scoped at construction, there is no method left that *can* forget.
 *
 * A useful consequence: another user's row id simply doesn't resolve - getLead
 * returns null, updateLead reports zero changes - so the handlers' existing
 * "not found" paths become the cross-user access check for free, with no new
 * branch to keep correct.
 *
 * Users and sessions are the exception and live in auth.js instead, because
 * resolving *which* user is calling necessarily happens before there's a
 * user-scoped Db to ask.
 *
 * New to JS? A "class" here is just a bundle of related functions (the
 * methods below) that share some state - the D1 binding and the user id,
 * stored in the constructor. `new Db(env.DB, userId)` makes one instance;
 * every method call after that (`db.getLead(5)`) automatically has access to
 * both without you passing them around everywhere.
 *
 * ---- JSDoc typedefs: this project has no build step (see client/README.md),
 * so there's no TypeScript compiler. @typedef comments are the zero-build
 * substitute: plain comments that do nothing at runtime, but that VS Code
 * (and `tsc --checkJs`, if you ever want to run it) read to give you
 * autocomplete and type-checking on plain .js files. Think of them as the
 * "contract" for what shape an object has - documentation a tool can verify
 * for you, instead of documentation that quietly goes stale.
 */

/**
 * @typedef {Object} Lead
 * @property {number} id
 * @property {string} user_id
 * @property {string} search - track key, matches Track.key
 * @property {string} found - YYYY-MM-DD, date first found
 * @property {string} company
 * @property {string} title
 * @property {string} location
 * @property {string} url
 * @property {string} verified - YYYY-MM-DD, date last verified live
 * @property {string} fit
 * @property {string} status - one of LEAD_STATUS in api.js
 * @property {string} notes
 * @property {string} team
 * @property {string} setup
 * @property {string} source
 * @property {string} link
 * @property {string} lastContact
 * @property {string} nextAction
 * @property {string} nextActionDate
 * @property {string} resume
 * @property {string} referral
 * @property {string} comp
 */

/**
 * @typedef {Object} Application
 * @property {number} id
 * @property {string} user_id
 * @property {string} leadId - the originating Lead.id as text, or '' if added by hand
 * @property {string} company
 * @property {string} title
 * @property {string} dateApplied - YYYY-MM-DD
 * @property {string} status - one of APP_STATUS in api.js
 * @property {string} notes
 * @property {string} team
 * @property {string} setup
 * @property {string} source
 * @property {string} link
 * @property {string} lastContact
 * @property {string} nextAction
 * @property {string} nextActionDate
 * @property {string} resume
 * @property {string} referral
 * @property {string} comp
 * @property {string} dateRecruiterScreen
 * @property {string} dateTechScreen
 * @property {string} dateOnsite
 * @property {string} dateOffer
 * @property {string} dateRejected
 * @property {string} dateWithdrawn
 */

/**
 * @typedef {Object} ScreenedItem
 * @property {number} id
 * @property {string} user_id
 * @property {string} search - track key
 * @property {string} url
 * @property {string} company
 * @property {string} title
 * @property {string} location
 * @property {string} reason
 * @property {string} date - YYYY-MM-DD, date screened
 */

/**
 * @typedef {Object} SearchRun
 * @property {string} user_id
 * @property {string} track_key
 * @property {string} last_run_at - ISO 8601 UTC instant, or '' if never recorded
 * @property {string} last_run_on - YYYY-MM-DD, the installer's local date
 * @property {string} status - 'ok' | 'error' | ''
 * @property {number} leads_added
 * @property {number} screened_added
 * @property {number} delisted
 * @property {string} note
 */

/**
 * @typedef {Object} Track
 * @property {string} key
 * @property {string} label
 * @property {string} full_description
 * @property {number} sort_order
 * @property {string} role_search_line
 * @property {string} target_companies - JSON array of company names
 * @property {string} search_note
 * @property {string} resume_line
 * @property {string} fit_clause
 * @property {string} fit_disqualifier
 * @property {string} doc_file
 * @property {string} doc_summary
 * @property {string} fit_filter_step
 * @property {string} leads_note
 * @property {string} doc_update_line
 * @property {string} intro_note
 * @property {string} report_line
 * @property {string} screened_examples
 * @property {string} schedule_time
 * @property {string} fed_by - key of the sibling track whose search fills this tab, '' when this track runs its own
 */

/**
 * @typedef {Track & {last_run: {at: string, on: string, status: string, leads_added: number, screened_added: number, delisted: number, note: string}}} TrackWithRun
 */

/**
 * @typedef {Object} Settings
 * @property {string} display_title
 * @property {string} overview_label
 * @property {string} applications_label
 * @property {number} stale_run_hours
 * @property {Array<Object>} priority_locations
 * @property {string[]} excluded_companies
 * @property {string} geo_scope_line
 * @property {string} scope_clause
 * @property {string} scope_disqualifier
 * @property {string} location_guidance
 * @property {string} footer_note
 * @property {string} pronouns
 */

import { canonicalUrl } from "./url.js";

// Same field lists api.js validates/whitelists against - re-exported from
// here so there is exactly one definition, not two that can drift apart.
export const EXTRA_FIELDS = [
  "team", "setup", "source", "link", "lastContact",
  "nextAction", "nextActionDate", "resume", "referral", "comp",
];
export const APP_STAGE_DATE_FIELDS = [
  "dateRecruiterScreen", "dateTechScreen", "dateOnsite",
  "dateOffer", "dateRejected", "dateWithdrawn",
];

// The `reason` written on the screened row a delisted lead leaves behind.
// Since 0004_drop_lead_delisted_on.sql deletes the lead outright, that row is
// the only surviving evidence a posting came down, and countRunActivity splits
// the day's screened rows on this exact text to tell a delisting from an
// ordinary rejection. A string a run's `delisted` count depends on gets one
// definition, for the same reason EXTRA_FIELDS above does.
//
// 0004 hardcodes the same text in SQL and cannot import it. Changing this
// would also silently reclassify every historical row, which is a good reason
// not to.
export const DELISTED_REASON = "posting taken down";

// Everything on a track row that isn't its identity (key) or its ordering.
// Split in two because the two halves have different audiences: the first is
// read by the client to draw tabs, the second only by prompt.js to compose
// the daily search. Both are written by POST /api/config.
export const TRACK_DISPLAY_FIELDS = ["label", "full_description", "sort_order"];
export const TRACK_CONFIG_FIELDS = [
  "role_search_line", "target_companies", "search_note", "resume_line",
  "fit_clause", "fit_disqualifier", "fit_filter_step", "leads_note",
  "doc_file", "doc_summary", "doc_update_line", "intro_note", "report_line",
  "screened_examples", "schedule_time", "fed_by",
];

// Settings the client renders from...
export const SETTING_KEYS = [
  "display_title", "overview_label", "applications_label", "stale_run_hours",
];
// ...and settings only prompt.js reads. Prose, stored verbatim: these are the
// per-user half of the search config (the per-track half is TRACK_CONFIG_FIELDS),
// and regenerating their sentences from keywords is exactly what would drop the
// hand-written detail the live searches depend on.
export const PROMPT_SETTING_KEYS = [
  "geo_scope_line", "scope_clause", "scope_disqualifier",
  "location_guidance", "footer_note", "pronouns",
];

export const DEFAULT_SETTINGS = {
  display_title: "Job Search Tracker",
  overview_label: "Overview",
  applications_label: "Applications",
  stale_run_hours: 36,
  priority_locations: [],
  // Companies this person will not work for, at all. A list rather than a
  // sentence buried in a track's prose: "is X excluded?" should be a lookup,
  // and adding one should be an append, not surgery on a paragraph.
  excluded_companies: [],
  // No geographic restriction by default: an unconfigured deployment shouldn't
  // silently filter out postings it was never told to exclude.
  geo_scope_line: "",
  scope_clause: "",
  scope_disqualifier: "",
  location_guidance:
    "Write accurate location strings - the tracker derives priority from them " +
    "automatically, so precision matters. There is no priority field to set - " +
    "just get the location text right.",
  footer_note: "",
  pronouns: "they/them",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// How many lead ids one statement may name in an `IN (...)` list. D1 caps a
// query at 100 bound parameters, and a nightly run re-confirming the postings
// it tracks routinely reports more leads than that in one call - the whole
// reason /api/verified takes a list instead of one URL per request. Over the
// cap D1 rejects the statement outright, so this splits the ids across several
// statements sent as one batch rather than letting a busy night be the thing
// that discovers the limit. 90, not 100: the same statement also binds the
// date and the user id.
const ID_CHUNK = 90;

export class Db {
  /**
   * @param {D1Database} d1
   * @param {string} userId - every statement below is filtered to this user
   */
  constructor(d1, userId) {
    this.d1 = d1;
    this.userId = userId;
  }

  // ---------------------------------------------------------------- meta --

  /** @returns {Promise<string|null>} this user's 'updated' timestamp, or null if never set */
  async getUpdatedTimestamp() {
    const row = await this.d1
      .prepare("SELECT value FROM meta WHERE user_id = ? AND key = 'updated'")
      .bind(this.userId)
      .first();
    return row ? row.value : null;
  }

  /** Stamps 'updated' with today's date - call after any write a viewer should see reflected. */
  async touchUpdated() {
    await this.d1
      .prepare(
        `INSERT INTO meta (user_id, key, value) VALUES (?, 'updated', ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      )
      .bind(this.userId, today())
      .run();
  }

  // -------------------------------------------------------- full dumps --

  /** @returns {Promise<Lead[]>} */
  async getAllLeads() {
    const res = await this.d1
      .prepare("SELECT * FROM leads WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /** @returns {Promise<Application[]>} */
  async getAllApplications() {
    const res = await this.d1
      .prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /** @returns {Promise<ScreenedItem[]>} */
  async getAllScreened() {
    const res = await this.d1
      .prepare("SELECT * FROM screened WHERE user_id = ? ORDER BY id")
      .bind(this.userId)
      .all();
    return res.results;
  }

  /**
   * The smallest thing a daily run needs to avoid re-processing what it has
   * already seen: for one track, the ids/urls/statuses of its leads and the
   * urls it has already screened out.
   *
   * This exists because the runs were using GET /api/data for it, which
   * returns every field of every row across every track - 398KB to use 22KB
   * of, at a point where screened rows were accumulating ~150/day. That grows
   * without bound and lands in the run's context every night, so the failure
   * mode was a run eventually truncating its own dedup list and re-adding
   * postings it had already ruled out. Selecting three columns for one track
   * keeps it roughly flat instead.
   *
   * `status` is here because the run needs it to tell a stale lead nobody has
   * touched from one already applied to; `id` because a posting confirmed
   * dead posts back against it (see api.js's removeDelistedLead).
   * @param {string} trackKey
   * @returns {Promise<{leads: Array<{id: number, url: string, status: string}>, screened: string[]}>}
   */
  async getDedupData(trackKey) {
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare("SELECT id, url, status FROM leads WHERE user_id = ? AND search = ? ORDER BY id")
        .bind(this.userId, trackKey)
        .all(),
      this.d1
        .prepare("SELECT url FROM screened WHERE user_id = ? AND search = ? ORDER BY id")
        .bind(this.userId, trackKey)
        .all(),
    ]);
    return { leads: leads.results, screened: screened.results.map((r) => r.url) };
  }

  // ---------------------------------------------------- company sweeps --

  /**
   * The companies a run should cover, least-recently-swept first - '' (never
   * swept) sorts before any date, so a freshly seeded list is worked through
   * before anything is re-covered.
   *
   * The cap is applied here rather than described to the run, because a cap a
   * model is asked to respect is not a cap. There is no privileged tier on top
   * of it either: a cheap JSON board is a reason a company is quick to cover,
   * not a reason to cover it every single night while the rest of the list
   * waits.
   *
   * `limit` of 0 returns everything, for seeding and for looking at the table.
   * @param {string} search @param {number} [limit]
   * @returns {Promise<{company: string, last_swept: string, board: string, note: string}[]>}
   */
  async getCoverage(search, limit = 0) {
    const rows = await this.d1
      .prepare(
        `SELECT company, last_swept, board, note FROM company_sweeps
         WHERE user_id = ? AND search = ? ORDER BY last_swept, company` +
          (limit > 0 ? " LIMIT ?" : "")
      )
      .bind(...(limit > 0 ? [this.userId, search, limit] : [this.userId, search]))
      .all();
    return rows.results;
  }

  /** @param {string} search @returns {Promise<number>} how many companies this search tracks */
  async countCoverage(search) {
    const row = await this.d1
      .prepare("SELECT COUNT(*) AS n FROM company_sweeps WHERE user_id = ? AND search = ?")
      .bind(this.userId, search)
      .first();
    return row ? row.n : 0;
  }

  /**
   * Upsert one row per company covered. Creating on write rather than needing
   * a separate "add this company" call is deliberate: broader discovery turns
   * up companies that were never on any list, and the run recording that it
   * swept one is exactly the moment the row should start existing.
   *
   * `board`, `note` and the date itself only overwrite when non-empty - a run
   * that stamps a date shouldn't blank the endpoint an earlier run confirmed,
   * and an empty `on` is how a caller registers companies *without* claiming to
   * have swept them (seeding a list, or adding one broader discovery found).
   * Registering must never look like a sweep: a seeded row has to sort ahead
   * of everything already covered, which is exactly what an empty date does.
   * @param {string} search
   * @param {{company: string, board?: string, note?: string}[]} items
   * @param {string} on - YYYY-MM-DD
   */
  async recordSweeps(search, items, on) {
    const stmt = this.d1.prepare(
      `INSERT INTO company_sweeps (user_id, search, company, last_swept, board, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, search, company) DO UPDATE SET
         last_swept = CASE WHEN excluded.last_swept <> '' THEN excluded.last_swept ELSE company_sweeps.last_swept END,
         board = CASE WHEN excluded.board <> '' THEN excluded.board ELSE company_sweeps.board END,
         note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE company_sweeps.note END`
    );
    await this.d1.batch(
      items.map((i) =>
        stmt.bind(this.userId, search, i.company, on, typeof i.board === "string" ? i.board : "",
          typeof i.note === "string" ? i.note : "")
      )
    );
    return items.length;
  }

  // -------------------------------------------------- tracks & settings --

  /** @returns {Promise<{tracks: TrackWithRun[], settings: Settings}>} */
  async getTracksAndSettings() {
    const trackCols = ["key", ...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS]
      .map((f) => `t.${f}`)
      .join(", ");
    const settingKeys = ["priority_locations", "excluded_companies", ...SETTING_KEYS, ...PROMPT_SETTING_KEYS];
    const [tracksRes, settingsRows] = await Promise.all([
      this.d1
        .prepare(
          `SELECT ${trackCols},
                  r.last_run_at, r.last_run_on, r.status AS last_run_status,
                  r.leads_added, r.screened_added, r.delisted, r.note
           FROM tracks t
           LEFT JOIN search_runs r ON r.track_key = t.key AND r.user_id = t.user_id
           WHERE t.user_id = ?
           ORDER BY t.sort_order, t.key`
        )
        .bind(this.userId)
        .all(),
      this.d1
        .prepare(
          `SELECT key, value FROM meta WHERE user_id = ? AND key IN (${settingKeys
            .map(() => "?")
            .join(", ")})`
        )
        .bind(this.userId, ...settingKeys)
        .all(),
    ]);

    const settings = { ...DEFAULT_SETTINGS };
    for (const row of settingsRows.results) {
      if (row.key === "priority_locations" || row.key === "excluded_companies") {
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = [];
        }
      } else if (row.key === "stale_run_hours") {
        const n = Number(row.value);
        if (Number.isFinite(n) && n > 0) settings.stale_run_hours = n;
      } else {
        settings[row.key] = row.value;
      }
    }

    const tracks = tracksRes.results.map((row) => {
      const track = { key: row.key };
      for (const f of [...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS]) track[f] = row[f];
      track.last_run = {
        at: row.last_run_at || "",
        on: row.last_run_on || "",
        status: row.last_run_status || "",
        leads_added: row.leads_added || 0,
        screened_added: row.screened_added || 0,
        delisted: row.delisted || 0,
        note: row.note || "",
      };
      return track;
    });

    return { tracks, settings };
  }

  /** @param {string} key @returns {Promise<Track|null>} */
  async getTrack(key) {
    const row = await this.d1
      .prepare("SELECT * FROM tracks WHERE user_id = ? AND key = ?")
      .bind(this.userId, key)
      .first();
    return row || null;
  }

  /** @param {string} key @returns {Promise<boolean>} */
  async trackExists(key) {
    return !!(await this.getTrack(key));
  }

  /**
   * How many rows a retired search still has, per table. Read-only, and the
   * thing a purge should be able to show someone before it runs.
   * @param {string} key
   * @returns {Promise<{leads: number, screened: number, sweeps: number, runs: number, applications: number}>}
   */
  async countSearchRows(key) {
    const one = async (sql) =>
      ((await this.d1.prepare(sql).bind(this.userId, key).first()) || {}).n || 0;
    const [leads, screened, sweeps, runs] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM screened WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM company_sweeps WHERE user_id = ? AND search = ?"),
      one("SELECT COUNT(*) AS n FROM search_runs WHERE user_id = ? AND track_key = ?"),
    ]);
    // Applications don't carry a search of their own; they point at a lead id.
    // This is the count that would be left pointing at nothing.
    const apps = await this.d1
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
          WHERE user_id = ? AND leadId != ''
            AND leadId IN (SELECT CAST(id AS TEXT) FROM leads WHERE user_id = ? AND search = ?)`
      )
      .bind(this.userId, this.userId, key)
      .first();
    return { leads, screened, sweeps, runs, applications: (apps && apps.n) || 0 };
  }

  /**
   * Removes every trace of one retired search: its leads, the postings it
   * screened, its slice of the company rotation, and its run record.
   *
   * All four tables in one transaction, because a half-purged search is worse
   * than an un-purged one - screened rows with no leads still suppress
   * rediscovery, and a surviving rotation slice still hands companies to a
   * search that no longer exists.
   *
   * ---- Applications are kept, and un-pointed rather than deleted. An
   * application row references its originating lead by id, and that lead is
   * about to stop existing. Deleting the application would throw away the
   * record of having applied to a job, which is the single least recoverable
   * thing in this database - the posting is gone from the internet too, so
   * nothing could reconstruct it. Leaving the id would leave a pointer into
   * nothing. So `leadId` is cleared to '', which the schema already defines as
   * "added by hand" (see migrations/0001_schema.sql) - exactly what such a row
   * becomes once the lead behind it is gone.
   *
   * Deliberately no status check. deleteLeadAndScreen refuses to remove an
   * applied-to lead, because there it is acting on one posting's report of
   * being taken down and the application is the thing still being tracked.
   * This is a different operation: the whole search is being retired on
   * purpose, and the caller has said so. The applications survive it either
   * way, which is what makes that safe.
   *
   * @param {string} key
   * @returns {Promise<{leads: number, screened: number, sweeps: number, runs: number, applications: number}>} rows affected
   */
  async purgeSearch(key) {
    const before = await this.countSearchRows(key);
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE applications SET leadId = ''
            WHERE user_id = ? AND leadId != ''
              AND leadId IN (SELECT CAST(id AS TEXT) FROM leads WHERE user_id = ? AND search = ?)`
        )
        .bind(this.userId, this.userId, key),
      this.d1.prepare("DELETE FROM leads WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM screened WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM company_sweeps WHERE user_id = ? AND search = ?").bind(this.userId, key),
      this.d1.prepare("DELETE FROM search_runs WHERE user_id = ? AND track_key = ?").bind(this.userId, key),
    ]);
    return before;
  }

  /**
   * Replaces this user's whole track list in one batch (one real transaction)
   * and keeps `search_runs` 1:1 with it - a new track gets an empty "never
   * ran" row, a removed track's run row goes with it. Scoped to this user
   * throughout: another person's tracks are neither read, updated, nor caught
   * by the "not in the new list" deletes.
   * @param {Array<Partial<Track> & {key: string}>} tracks
   */
  async replaceTracks(tracks) {
    const cols = [...TRACK_DISPLAY_FIELDS, ...TRACK_CONFIG_FIELDS];

    // A field the payload doesn't mention keeps its stored value, rather than
    // being overwritten with ''. `tracks` replaces the *list* - which tracks
    // exist - but a caller posting `{key, label}` to rename a tab is not
    // asking to erase that track's target companies, resume line and schedule.
    // Without this they'd be silently blanked, and the next morning's prompt
    // would fall back to its generic defaults and still look fine. Clearing a
    // field is done by sending it as "".
    const existing = {};
    const current = await this.d1
      .prepare(`SELECT key, ${cols.join(", ")} FROM tracks WHERE user_id = ?`)
      .bind(this.userId)
      .all();
    for (const row of current.results) existing[row.key] = row;

    // Falls back through: what was posted, then what's stored, then the
    // default. `sort_order` needs the same treatment as the text fields -
    // defaulting it to the array index silently reorders someone's tabs when
    // a caller posts the tracks in a different order than they're displayed.
    const keep = (t, f, fallback) => {
      const stored = existing[t.key] && existing[t.key][f];
      return stored !== undefined && stored !== null ? stored : fallback;
    };
    const stmt = this.d1.prepare(
      `INSERT INTO tracks (user_id, key, ${cols.join(", ")})
       VALUES (?, ?, ${cols.map(() => "?").join(", ")})
       ON CONFLICT(user_id, key) DO UPDATE SET
         ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`
    );
    // INSERT OR IGNORE, not a plain INSERT - re-posting an unchanged track
    // list is the normal case and must not wipe existing run history.
    const runStmt = this.d1.prepare(
      "INSERT OR IGNORE INTO search_runs (user_id, track_key) VALUES (?, ?)"
    );
    const placeholders = tracks.map(() => "?").join(", ");
    const keys = tracks.map((t) => t.key);
    const batch = [
      this.d1
        .prepare(`DELETE FROM tracks WHERE user_id = ? AND key NOT IN (${placeholders})`)
        .bind(this.userId, ...keys),
      this.d1
        .prepare(`DELETE FROM search_runs WHERE user_id = ? AND track_key NOT IN (${placeholders})`)
        .bind(this.userId, ...keys),
      ...tracks.map((t, i) =>
        stmt.bind(
          this.userId,
          t.key,
          typeof t.label === "string" && t.label ? t.label : keep(t, "label", t.key),
          typeof t.full_description === "string" ? t.full_description : keep(t, "full_description", ""),
          Number.isInteger(t.sort_order) ? t.sort_order : keep(t, "sort_order", i),
          ...TRACK_CONFIG_FIELDS.map((f) => {
            // target_companies is the one structured field: accept an array
            // and store it as JSON, or pass through a string that already is.
            if (f === "target_companies" && Array.isArray(t[f])) return JSON.stringify(t[f]);
            if (typeof t[f] === "string") return t[f];
            return keep(t, f, "");
          })
        )
      ),
      ...keys.map((k) => runStmt.bind(this.userId, k)),
    ];
    await this.d1.batch(batch);
  }

  /**
   * Sets any subset of this user's settings.
   *
   * The two groups differ on what an empty string means, because what the
   * user wants from it differs. For a display label ("" as a page title) the
   * only sensible reading is "use the default", so it's ignored and
   * DEFAULT_SETTINGS applies. For a prompt setting, "" is a real instruction:
   * dropping a geographic restriction, or removing a footer note, means
   * clearing the text. Ignoring it there would mean a widened search scope
   * silently didn't take, and the searches would go on excluding what the
   * installer just told them to stop excluding.
   * @param {Partial<Settings>} patch
   */
  async setSettings(patch) {
    const labels = SETTING_KEYS.filter((k) => k !== "stale_run_hours");
    for (const key of labels) {
      if (typeof patch[key] === "string" && patch[key]) {
        await this.setSetting(key, patch[key]);
      }
    }
    for (const key of PROMPT_SETTING_KEYS) {
      if (typeof patch[key] === "string") {
        await this.setSetting(key, patch[key]);
      }
    }
    if (patch.stale_run_hours != null) {
      await this.setSetting("stale_run_hours", String(patch.stale_run_hours));
    }
    if (Array.isArray(patch.priority_locations)) {
      await this.setSetting("priority_locations", JSON.stringify(patch.priority_locations));
    }
    // An empty array is a real instruction here - "I no longer exclude anyone" -
    // so this checks for an array, not for a non-empty one.
    if (Array.isArray(patch.excluded_companies)) {
      await this.setSetting(
        "excluded_companies",
        JSON.stringify(patch.excluded_companies.filter((c) => typeof c === "string" && c.trim()))
      );
    }
  }

  /** @param {string} key @param {string} value */
  async setSetting(key, value) {
    await this.d1
      .prepare(
        `INSERT INTO meta (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
      )
      .bind(this.userId, key, value)
      .run();
  }

  // ------------------------------------------------------------- runs --

  /**
   * What one track actually gained on one date, counted from the rows
   * themselves. This is what a run record's three numbers are derived from
   * instead of being taken from the caller - see api.js's handleRecordRun for
   * why the caller's own tally isn't trusted.
   *
   * Three counts, three different places they can be read from, and only one
   * of them is obvious:
   *
   *   - `leadsAdded` is leads filed under this key with `found` = this date.
   *     `found` rather than an insert timestamp because that is the column the
   *     table actually has, and it is the date the run itself supplies.
   *   - `delisted` is counted out of `screened`, not out of `leads`, and that
   *     is not a stylistic choice: 0004_drop_lead_delisted_on.sql removed
   *     leads.delistedOn, and removeDelistedLead now DELETEs the lead and
   *     writes a screened row in its place. By the time anything could count
   *     the delisting, the lead row is gone - the screened row carrying
   *     DELISTED_REASON is the only trace left.
   *   - `screenedAdded` is therefore everything else screened that day. The
   *     two live in the same table on the same date under the same key, so
   *     without splitting them on the reason string every delisting would be
   *     counted twice, once in each column.
   *
   * A multi-tab run calls this once per tab; each key counts only its own
   * rows, which is the whole point of deriving them here.
   *
   * @param {string} key - track key
   * @param {string} on - YYYY-MM-DD, the run's own local date
   * @returns {Promise<{leadsAdded: number, screenedAdded: number, delisted: number}>}
   */
  async countRunActivity(key, on) {
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND search = ? AND found = ?")
        .bind(this.userId, key, on)
        .first(),
      // One pass over the day's screened rows rather than two queries that
      // would have to agree with each other about what "not delisted" means.
      this.d1
        .prepare(
          `SELECT SUM(CASE WHEN reason = ? THEN 1 ELSE 0 END) AS delisted,
                  SUM(CASE WHEN reason <> ? THEN 1 ELSE 0 END) AS screened
             FROM screened WHERE user_id = ? AND search = ? AND date = ?`
        )
        .bind(DELISTED_REASON, DELISTED_REASON, this.userId, key, on)
        .first(),
    ]);
    // SUM over zero rows is NULL in SQLite, not 0, and a quiet day is the
    // normal case here - so both sums are floored rather than passed through.
    return {
      leadsAdded: (leads && leads.n) || 0,
      screenedAdded: (screened && screened.screened) || 0,
      delisted: (screened && screened.delisted) || 0,
    };
  }

  /**
   * @param {string} key
   * @param {{at: string, on: string, status: string, leadsAdded: number, screenedAdded: number, delisted: number, note: string}} run
   * @returns {Promise<SearchRun>}
   */
  async recordRun(key, run) {
    const [row] = await this.recordRuns([{ key, ...run }]);
    return row;
  }

  /**
   * Writes a run record for every tab one run filled, as a single transaction.
   *
   * All of them or none of them, which is the entire point. A branched run
   * fills several tabs and each needs its own record, and the failure this
   * whole change exists to fix is a tab that was searched last night reading
   * as never having run. Writing them one at a time re-creates exactly that:
   * a worker that dies, times out, or hits a D1 error partway through leaves
   * the tabs it hadn't reached yet looking stale, and the run that could have
   * retried has already ended. d1.batch is a real transaction, so a partial
   * fan-out is not a state this can end up in.
   *
   * The counts are computed by the caller, per key, before any of this runs -
   * they are reads, and they must not be inside the write transaction.
   *
   * @param {Array<{key: string, at: string, on: string, status: string, leadsAdded: number, screenedAdded: number, delisted: number, note: string}>} runs
   * @returns {Promise<SearchRun[]>} the written rows, in the order asked for
   */
  async recordRuns(runs) {
    if (!runs.length) return [];
    const stmt = this.d1.prepare(
      `INSERT INTO search_runs
         (user_id, track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, track_key) DO UPDATE SET
         last_run_at = excluded.last_run_at, last_run_on = excluded.last_run_on,
         status = excluded.status, leads_added = excluded.leads_added,
         screened_added = excluded.screened_added, delisted = excluded.delisted,
         note = excluded.note`
    );
    await this.d1.batch(
      runs.map((r) =>
        stmt.bind(
          this.userId, r.key, r.at, r.on, r.status,
          r.leadsAdded, r.screenedAdded, r.delisted, r.note
        )
      )
    );

    const keys = runs.map((r) => r.key);
    const res = await this.d1
      .prepare(
        `SELECT * FROM search_runs
          WHERE user_id = ? AND track_key IN (${keys.map(() => "?").join(", ")})`
      )
      .bind(this.userId, ...keys)
      .all();
    // Read back in the caller's order, not the database's: the first entry is
    // the track the run posted about, and the response distinguishes it from
    // the tabs written on its behalf.
    const byKey = new Map(res.results.map((r) => [r.track_key, r]));
    return keys.map((k) => byKey.get(k)).filter(Boolean);
  }

  // ------------------------------------------------------------ leads --

  /**
   * Splits a batch into the rows whose posting this user doesn't already have,
   * and a count of the rest. Both insert paths dedup identically, so they
   * share this - see addLeads for what the two layers are and why.
   *
   * A row is already-known if its canonical URL (see ./url.js) matches a lead
   * OR a screened row already held by the same *search*: both mean "this run
   * has met this posting before".
   *
   * The search, not the track. Those differ for a branched search, where one
   * run fills several tabs (`fed_by`, see migrations/0003_branched_tracks.sql)
   * and step 7b decides which tab each finding belongs in. Scoped to the track
   * alone, a posting filed under one tab yesterday and sorted into a sibling
   * tab today reads as new, and the run adds it a second time - the same
   * duplicate this whole filter exists to stop, arriving by a different door.
   * The prompt already tells such a run to fetch dedup data per key and treat
   * it as one combined set; this is the server agreeing with it.
   *
   * Two *independent* tracks tracking one posting are still two rows on
   * purpose, which is what the UNIQUE constraint has always said. A feed group
   * is not two searches, it is one search with several outputs, so widening to
   * the group changes nothing for anyone who isn't running a branched search.
   *
   * Rows already accepted from this same batch join the set as it goes, which
   * is what catches one payload naming the same posting twice.
   *
   * @param {Array<{search: string, url: string}>} rows
   * @returns {Promise<{fresh: Array<Object>, duplicates: number}>}
   */
  async dropKnownUrls(rows) {
    const asked = [...new Set(rows.map((r) => r.search).filter(Boolean))];
    if (asked.length === 0) return { fresh: [], duplicates: rows.length };

    // A track's feed group: the track that runs the search, plus every tab it
    // fills. `fed_by` is one level (a fed track is a tab, not a search), so
    // the root is one hop and the group is everything sharing that root.
    const tracks = await this.d1
      .prepare("SELECT key, fed_by FROM tracks WHERE user_id = ?")
      .bind(this.userId)
      .all();
    const rootOf = new Map(tracks.results.map((t) => [t.key, t.fed_by || t.key]));
    const root = (k) => rootOf.get(k) || k;

    const roots = new Set(asked.map(root));
    const groupKeys = tracks.results.map((t) => t.key).filter((k) => roots.has(root(k)));
    // A key the batch names that isn't a configured track has no group; keep it
    // so it still dedups against itself rather than skipping the check.
    for (const k of asked) if (!groupKeys.includes(k)) groupKeys.push(k);

    const seen = new Map([...roots].map((r) => [r, new Set()]));
    const placeholders = groupKeys.map(() => "?").join(", ");
    const [leads, screened] = await Promise.all([
      this.d1
        .prepare(`SELECT search, url FROM leads WHERE user_id = ? AND search IN (${placeholders})`)
        .bind(this.userId, ...groupKeys)
        .all(),
      this.d1
        .prepare(`SELECT search, url FROM screened WHERE user_id = ? AND search IN (${placeholders})`)
        .bind(this.userId, ...groupKeys)
        .all(),
    ]);
    for (const row of [...leads.results, ...screened.results]) {
      seen.get(root(row.search))?.add(canonicalUrl(row.url));
    }

    const fresh = [];
    let duplicates = 0;
    for (const row of rows) {
      const key = canonicalUrl(row.url);
      const set = seen.get(root(row.search));
      if (!key || set?.has(key)) {
        duplicates++;
        continue;
      }
      set?.add(key);
      fresh.push(row);
    }
    return { fresh, duplicates };
  }

  /**
   * Inserts leads not already present for the same (user, search, posting).
   *
   * Two layers, and they catch different things. `INSERT OR IGNORE` against
   * `UNIQUE(user_id, search, url)` is the atomic, race-free backstop for a URL
   * repeated byte-for-byte. The canonical-key filter above it is what catches
   * the same posting arriving under a *different* URL - a `?gh_jid=` suffix, a
   * slug, a tracking param - which is how 8 duplicate leads landed in one
   * night's run on 2026-09-01. See ./url.js for the rule and the evidence.
   *
   * The filter is a read-then-write, so unlike the constraint it is not
   * race-free. That is an accepted trade rather than an oversight: a track's
   * leads are written by exactly one caller, its own nightly run, so two
   * concurrent inserts for one track do not happen in practice - and the
   * alternative was a table rebuild to move the UNIQUE constraint onto a
   * stored key, plus a generated backfill for every existing row. The
   * constraint still holds the line for the case that actually races.
   *
   * Within-batch duplicates are dropped too: one payload carrying the same
   * posting twice under two URLs is the same mistake as carrying it across two
   * runs, and INSERT OR IGNORE cannot see it either.
   *
   * Never touches an existing row's status/notes. Two users tracking the same
   * posting are two separate rows, by design.
   *
   * @param {Array<Partial<Lead>>} leads
   * @param {string} [on] the run's local date, used for `found`/`verified`
   *   when a lead doesn't carry its own - see the note on today() below
   * @returns {Promise<{added: number, duplicates: number}>} inserted, and how
   *   many were dropped as already-known
   */
  async addLeads(leads, on) {
    // The caller's local date when it sent one. The worker only knows UTC, and
    // a search scheduled in the evening is already the next UTC day - the same
    // reasoning /api/runs' `on` has always had. Falling back to UTC keeps the
    // behaviour every existing caller already gets.
    // Already validated by the caller (api.js's isoDate), so this only has to
    // choose between a date and none. Re-validating here would be a second
    // copy of the rule, and the two would eventually disagree.
    const t = on || today();

    const { fresh, duplicates } = await this.dropKnownUrls(leads);
    if (fresh.length === 0) return { added: 0, duplicates };

    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO leads
         (user_id, search, found, company, title, location, url, verified, fit, status, notes, ${EXTRA_FIELDS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', '', ${EXTRA_FIELDS.map(() => "?").join(", ")})`
    );
    const batch = fresh.map((lead) =>
      stmt.bind(
        this.userId,
        lead.search,
        lead.found || t,
        lead.company,
        lead.title,
        lead.location || "",
        lead.url,
        lead.verified || t,
        lead.fit || "",
        ...EXTRA_FIELDS.map((f) => lead[f] || "")
      )
    );
    const results = await this.d1.batch(batch);
    return { added: results.reduce((n, r) => n + (r.meta.changes || 0), 0), duplicates };
  }

  /** @param {number|string} id @returns {Promise<Lead|null>} */
  async getLead(id) {
    return this.d1
      .prepare("SELECT * FROM leads WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .first();
  }

  /**
   * Field-whitelist partial update - only keys present in `patch` (as
   * strings) are changed; everything else is left as-is via COALESCE.
   *
   * `search` is in the list so a lead can be moved between this user's tabs -
   * the case that turns up when one track is split in two, since a lead's
   * track is otherwise fixed at the moment the search filed it and there is no
   * delete route to re-add it through. The caller (handleUpdate) is what
   * checks the target track exists and catches the UNIQUE(user_id, search,
   * url) collision; both are policy, not storage.
   * @param {number|string} id
   * @param {Partial<Lead>} patch
   * @returns {Promise<Lead|null>} the updated row, or null if no row matched
   */
  async updateLead(id, patch) {
    const fields = ["status", "notes", "search", ...EXTRA_FIELDS];
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof patch[f] === "string" ? patch[f] : null));
    const result = await this.d1
      .prepare(`UPDATE leads SET ${setClause} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getLead(id);
  }

  /**
   * Every lead this user tracks, in the few columns URL matching and the
   * delisting policy actually need: `id` and `url` to match on, `status` for
   * the applied-to check, and the company/title/location that
   * deleteLeadAndScreen copies onto the screened row it leaves behind.
   *
   * Whole table rather than a `WHERE url IN (...)` narrowing, because the match
   * these callers make is canonicalUrl's (see ./url.js) and that is JS, not
   * SQL. A SQL `IN` list would be the raw string comparison url.js exists
   * because of: it would miss the `?gh_jid=` variant of a URL the run reports
   * and hand back "nothing tracked matches this", which for /api/delist means a
   * dead posting quietly stays on the board.
   *
   * Deliberately not scoped to one track, even though both callers are handed a
   * track key. A run that fills several tabs fetches dedup data per key and
   * treats it as one combined already-seen set - the prompt says so in as many
   * words - so the postings it re-checks are not all in the tab it reports
   * under. Scoping here would drop those from the match and report them back as
   * unmatched, which is the signal reserved for the run and the tracker
   * genuinely disagreeing about what is tracked. A posting is live or dead on
   * its own terms; which of this person's tabs holds it isn't part of that.
   * @returns {Promise<Array<{id: number, search: string, url: string, status: string, company: string, title: string, location: string}>>}
   */
  async getLeadsForUrlMatch() {
    const res = await this.d1
      .prepare(
        `SELECT id, search, url, status, company, title, location
           FROM leads WHERE user_id = ? ORDER BY id`
      )
      .bind(this.userId)
      .all();
    return res.results;
  }

  /**
   * Stamps `verified` on the given leads - the date someone last confirmed
   * these postings were still live.
   *
   * Nothing wrote this column between a lead being created and this method
   * existing: 267 of 279 older leads on the live deployment still read
   * `verified === found`, because the only thing a run ever reported back about
   * a posting it re-checked was that it was DEAD. Since delisting started
   * deleting the row (migrations/0004_drop_lead_delisted_on.sql), a lead still
   * sitting in a tab is implicitly presumed live, and this column is the only
   * remaining answer to "how long since anyone actually looked?".
   *
   * The stamp is unconditional rather than `MAX(verified, on)`. A date that
   * moves backwards - a run with a wrong clock, a report replayed late - costs
   * one extra re-check and nothing else, whereas refusing to move it backwards
   * would silently swallow a correction and leave the column claiming a posting
   * was confirmed on a day nobody confirmed it. The value is already validated
   * as YYYY-MM-DD by the caller; this only decides what to do with a real date.
   * @param {Array<number|string>} ids
   * @param {string} on - YYYY-MM-DD, the run's own local date
   * @returns {Promise<number>} how many rows were actually stamped
   */
  async markVerified(ids, on) {
    if (!ids.length) return 0;
    const chunks = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
    const results = await this.d1.batch(
      chunks.map((chunk) =>
        this.d1
          .prepare(
            `UPDATE leads SET verified = ?
              WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`
          )
          .bind(on, this.userId, ...chunk)
      )
    );
    return results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }

  // -------------------------------------------------------- screened --

  /**
   * Same two-layer dedup as addLeads - canonical-key filter over an
   * INSERT-OR-IGNORE backstop - and for the same reason.
   *
   * A URL already tracked as a *lead* is dropped here too, not just one
   * already screened. A run posting both about one posting is contradicting
   * itself: step 7 sorts a candidate into tracked-or-screened, a finding, or a
   * disqualified new one, and those are exclusive. Four such pairs exist in
   * the live data, and the lead is the row worth keeping.
   *
   * deleteLeadAndScreen does not come through here, so a posting being taken
   * off the board still gets its screened row while its lead is deleted in the
   * same transaction.
   *
   * @param {Array<Partial<ScreenedItem>>} items
   * @param {string} [on] the run's local date, for items without their own
   * @returns {Promise<{added: number, duplicates: number}>}
   */
  async addScreened(items, on) {
    // Already validated by the caller (api.js's isoDate), so this only has to
    // choose between a date and none. Re-validating here would be a second
    // copy of the rule, and the two would eventually disagree.
    const t = on || today();

    const { fresh, duplicates } = await this.dropKnownUrls(items);
    if (fresh.length === 0) return { added: 0, duplicates };

    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = fresh.map((item) =>
      stmt.bind(
        this.userId,
        item.search,
        item.url,
        item.company || "",
        item.title || "",
        item.location || "",
        item.reason || "",
        item.date || t
      )
    );
    const results = await this.d1.batch(batch);
    return { added: results.reduce((n, r) => n + (r.meta.changes || 0), 0), duplicates };
  }

  // ----------------------------------------------------- applications --

  /** @param {number|string} id @returns {Promise<Application|null>} */
  async getApplication(id) {
    return this.d1
      .prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .first();
  }

  /** @param {number|string} leadId @returns {Promise<Application|null>} */
  async getApplicationByLeadId(leadId) {
    return this.d1
      .prepare("SELECT * FROM applications WHERE leadId = ? AND user_id = ? LIMIT 1")
      .bind(String(leadId), this.userId)
      .first();
  }

  /**
   * @param {Partial<Application>} fields
   * @returns {Promise<Application>}
   */
  async insertApplication(fields) {
    const cols = ["leadId", "company", "title", "dateApplied", "status", "notes", ...EXTRA_FIELDS, ...APP_STAGE_DATE_FIELDS];
    const placeholders = ["?", ...cols.map(() => "?")].join(", ");
    const values = cols.map((f) => {
      if (f === "dateApplied") return fields.dateApplied || today();
      if (f === "status") return fields.status || "Applied";
      return fields[f] || "";
    });
    const result = await this.d1
      .prepare(`INSERT INTO applications (user_id, ${cols.join(", ")}) VALUES (${placeholders})`)
      .bind(this.userId, ...values)
      .run();
    return this.getApplication(result.meta.last_row_id);
  }

  /**
   * Field-whitelist partial update, same COALESCE pattern as updateLead.
   * @param {number|string} id
   * @param {Partial<Application>} patch
   * @returns {Promise<Application|null>}
   */
  async updateApplication(id, patch) {
    const fields = ["company", "title", "dateApplied", "status", "notes", "leadId", ...EXTRA_FIELDS, ...APP_STAGE_DATE_FIELDS];
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof patch[f] === "string" ? patch[f] : null));
    const result = await this.d1
      .prepare(`UPDATE applications SET ${setClause} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getApplication(id);
  }

  /** @param {number|string} id @returns {Promise<boolean>} true if a row was actually deleted */
  async deleteApplication(id) {
    const result = await this.d1
      .prepare("DELETE FROM applications WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Sets status and, the first time it reaches a stage with a history
   * column, stamps that column with a date - but only if it's still empty,
   * so it never overwrites a date the user corrected by hand.
   * @param {number|string} id
   * @param {string} status
   * @param {string|null} stageDateColumn - one of APP_STAGE_DATE_FIELDS (or dateApplied, for "Applied"), or null if this status has none
   * @param {string|null} clearColumn - a date column to blank instead of stamp - see handleSetApplicationStatus's "To Apply" case
   * @param {string|null} explicitDate - the date the client says this actually happened on (YYYY-MM-DD, already validated by the caller), or null to fall back to today - see handleSetApplicationStatus
   * @returns {Promise<Application|null>}
   */
  async setApplicationStatus(id, status, stageDateColumn, clearColumn = null, explicitDate = null) {
    // Column names here come from api.js's own constants, never from the
    // request body, so they're safe to interpolate; the values still bind.
    const sets = ["status = ?"];
    const values = [status];
    if (stageDateColumn) {
      sets.push(`${stageDateColumn} = CASE WHEN ${stageDateColumn} = '' THEN ? ELSE ${stageDateColumn} END`);
      values.push(explicitDate || today());
    }
    if (clearColumn) sets.push(`${clearColumn} = ''`);
    const result = await this.d1
      .prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getApplication(id);
  }

  // ------------------------------------------------------- composite --

  /**
   * Atomically (one D1 batch/transaction) sets a lead's status and,
   * optionally, inserts a new application row alongside it - so a lead can
   * never end up "Applied" with no application because a second, separate
   * write failed partway. Whether to create one is the caller's decision
   * (business logic: "Applied" + no existing application yet) - this method
   * just makes doing both atomic once that decision's been made.
   * @param {number|string} id
   * @param {string} status
   * @param {Partial<Application>|null} newApplicationFields - pass an object to also create an application in the same transaction, or null to just set the status
   * @returns {Promise<{lead: Lead|null, application: Application|null}>}
   */
  async setLeadStatusAndMaybeCreateApplication(id, status, newApplicationFields) {
    const batch = [
      this.d1
        .prepare("UPDATE leads SET status = ? WHERE id = ? AND user_id = ?")
        .bind(status, id, this.userId),
    ];
    if (newApplicationFields) {
      const cols = ["leadId", "company", "title", "dateApplied", "status", "notes", "link", "referral", "comp", "team", "setup"];
      const values = cols.map((f) => {
        if (f === "dateApplied") return newApplicationFields.dateApplied || today();
        if (f === "status") return newApplicationFields.status || "Applied";
        return newApplicationFields[f] || "";
      });
      batch.push(
        this.d1
          .prepare(
            `INSERT INTO applications (user_id, ${cols.join(", ")}) VALUES (${["?", ...cols.map(() => "?")].join(", ")})`
          )
          .bind(this.userId, ...values)
      );
    }
    const results = await this.d1.batch(batch);

    const lead = await this.getLead(id);
    let application = null;
    if (newApplicationFields) {
      application = await this.getApplication(results[1].meta.last_row_id);
    }
    return { lead, application };
  }

  /**
   * Atomically (one D1 batch/transaction) deletes a lead and records its URL
   * in `screened` - the mechanism behind api.js's removeDelistedLead, which
   * owns the decision about when this should happen at all.
   *
   * Both halves have to land together, and they fail in opposite directions:
   * the delete alone leaves a URL nothing remembers, so tomorrow's run
   * rediscovers it and adds it back as a brand-new lead; the screened row
   * alone permanently hides a lead that is still sitting in the tab. Hence one
   * batch rather than two writes.
   *
   * The screened insert is ordered first so that the recoverable direction is
   * the one a partial failure can take: a screened row with its lead still
   * present is visible and fixable, a deleted lead is gone. INSERT OR IGNORE
   * because (user, search, url) is unique and a re-reported posting is a
   * no-op, not an error.
   *
   * The screened row it leaves behind is all that remains of the lead, so it
   * carries the company/title/location too, not just the URL - enough to read
   * later as "this is what was here and when it went".
   *
   * Deleting a lead an application points at would strand that row;
   * removeDelistedLead checks for one (not just for status "Applied", which a
   * lead carrying an application can be moved out of) and never calls this
   * when one exists.
   * @param {Lead} lead - the already-fetched row, so this doesn't re-read it
   * @param {string} reason - short human-readable note stored on the screened row
   * @param {string|null} date - YYYY-MM-DD the posting was confirmed dead (the run's own local date), or null for today
   * @returns {Promise<boolean>} true if the lead row was actually deleted
   */
  async deleteLeadAndScreen(lead, reason, date = null) {
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          this.userId,
          lead.search,
          lead.url,
          lead.company || "",
          lead.title || "",
          lead.location || "",
          reason,
          date || today()
        ),
      this.d1
        .prepare("DELETE FROM leads WHERE id = ? AND user_id = ?")
        .bind(lead.id, this.userId),
    ]);
    return (results[1].meta.changes || 0) > 0;
  }
}
