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

// Everything on a track row that isn't its identity (key) or its ordering.
// Split in two because the two halves have different audiences: the first is
// read by the client to draw tabs, the second only by prompt.js to compose
// the daily search. Both are written by POST /api/config.
export const TRACK_DISPLAY_FIELDS = ["label", "full_description", "sort_order"];
export const TRACK_CONFIG_FIELDS = [
  "role_search_line", "target_companies", "search_note", "resume_line",
  "fit_clause", "fit_disqualifier", "fit_filter_step", "leads_note",
  "doc_file", "doc_summary", "doc_update_line", "intro_note", "report_line",
  "screened_examples", "schedule_time",
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
   * touched from one already applied to - the applied ones are exactly the
   * rows a run must never delete; `id` because a posting confirmed dead posts
   * back against it (see deleteLeadAndScreen).
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
   * @param {string} key
   * @param {{at: string, on: string, status: string, leadsAdded: number, screenedAdded: number, delisted: number, note: string}} run
   * @returns {Promise<SearchRun>}
   */
  async recordRun(key, run) {
    await this.d1
      .prepare(
        `INSERT INTO search_runs
           (user_id, track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track_key) DO UPDATE SET
           last_run_at = excluded.last_run_at, last_run_on = excluded.last_run_on,
           status = excluded.status, leads_added = excluded.leads_added,
           screened_added = excluded.screened_added, delisted = excluded.delisted,
           note = excluded.note`
      )
      .bind(this.userId, key, run.at, run.on, run.status, run.leadsAdded, run.screenedAdded, run.delisted, run.note)
      .run();
    return this.d1
      .prepare("SELECT * FROM search_runs WHERE user_id = ? AND track_key = ?")
      .bind(this.userId, key)
      .first();
  }

  // ------------------------------------------------------------ leads --

  /**
   * Inserts leads not already present for the same (user, search, url) triple
   * - DB-enforced UNIQUE constraint + INSERT OR IGNORE, atomic and race-free.
   * Never touches an existing row's status/notes. Two users tracking the same
   * posting are two separate rows, by design.
   * @param {Array<Partial<Lead>>} leads
   * @returns {Promise<number>} how many were actually inserted
   */
  async addLeads(leads) {
    const t = today();
    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO leads
         (user_id, search, found, company, title, location, url, verified, fit, status, notes, ${EXTRA_FIELDS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', '', ${EXTRA_FIELDS.map(() => "?").join(", ")})`
    );
    const batch = leads.map((lead) =>
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
    return results.reduce((n, r) => n + (r.meta.changes || 0), 0);
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
   * @param {number|string} id
   * @param {Partial<Lead>} patch
   * @returns {Promise<Lead|null>} the updated row, or null if no row matched
   */
  async updateLead(id, patch) {
    const fields = ["status", "notes", ...EXTRA_FIELDS];
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof patch[f] === "string" ? patch[f] : null));
    const result = await this.d1
      .prepare(`UPDATE leads SET ${setClause} WHERE id = ? AND user_id = ?`)
      .bind(...values, id, this.userId)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getLead(id);
  }

  // -------------------------------------------------------- screened --

  /**
   * Same INSERT-OR-IGNORE-on-(user, search, url) dedup shape as addLeads.
   * @param {Array<Partial<ScreenedItem>>} items
   * @returns {Promise<number>} how many were actually inserted
   */
  async addScreened(items) {
    const t = today();
    const stmt = this.d1.prepare(
      `INSERT OR IGNORE INTO screened (user_id, search, url, company, title, location, reason, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const batch = items.map((item) =>
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
    return results.reduce((n, r) => n + (r.meta.changes || 0), 0);
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
   * in `screened` - what the daily search does when a posting it tracked is
   * confirmed gone from the internet.
   *
   * Both halves have to land together, and they fail in opposite directions:
   * the delete alone leaves a URL nothing remembers, so tomorrow's run
   * rediscovers it and adds it back as a brand-new lead; the screened row
   * alone permanently hides a lead that is still sitting in the tab. Hence one
   * batch rather than two calls from the run.
   *
   * The screened insert is ordered first so that the recoverable direction is
   * the one a partial failure can take: a screened row with its lead still
   * present is visible and fixable, a deleted lead is gone. INSERT OR IGNORE
   * because (user, search, url) is unique and a re-reported posting is a
   * no-op, not an error.
   *
   * Deleting an "Applied" lead would strand the application row pointing at
   * its id - see api.js's handleDeleteLead, which refuses those before
   * reaching this method.
   * @param {Lead} lead - the already-fetched row, so this doesn't re-read it
   * @param {string} reason - short human-readable note stored on the screened row
   * @returns {Promise<boolean>} true if the lead row was actually deleted
   */
  async deleteLeadAndScreen(lead, reason) {
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
          today()
        ),
      this.d1
        .prepare("DELETE FROM leads WHERE id = ? AND user_id = ?")
        .bind(lead.id, this.userId),
    ]);
    return (results[1].meta.changes || 0) > 0;
  }
}
