/**
 * D1-backed API handlers for the Job Search Tracker API worker.
 * See ../migrations/ for schema, and index.js for routing.
 *
 * This worker is API-only (no page-serving) - the client is a separate
 * deployable (see ../../client/) that calls this API cross-origin, hence
 * CORS_HEADERS below on every response. `*` rather than a specific origin:
 * this is a self-hosted, per-installer deployment (each installer runs
 * their own worker + client + D1 + bearer token, never a shared multi-
 * tenant backend), and the Bearer token - not origin - is the actual
 * access boundary, so restricting the origin would add config surface
 * without adding real security.
 */

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token && env.API_TOKEN && token === env.API_TOKEN;
}

export function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function touchUpdated(env) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('updated', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(today()).run();
}

// Extra freeform fields shared by leads and applications - same columns on
// both tables (see migrations/), so a referral/comp/next-action can be jotted
// down on a posting before it's ever "applied to", and it's still there
// after it becomes an application.
export const EXTRA_FIELDS = [
  "team", "setup", "source", "link", "lastContact",
  "nextAction", "nextActionDate", "resume", "referral", "comp",
];

// When an application first reaches a given pipeline stage (see
// migrations/0001_schema.sql) - applications only, leads have no
// equivalent columns, so this must never be added to
// EXTRA_FIELDS above (that list is shared by both tables' UPDATE/INSERT
// statements below).
export const APP_STAGE_DATE_FIELDS = [
  "dateRecruiterScreen", "dateTechScreen", "dateOnsite",
  "dateOffer", "dateRejected", "dateWithdrawn",
];

// Valid status values, duplicated from page.html's LEAD_STATUS/APP_STATUS
// (same intentional-duplication pattern as EXTRA_FIELDS above - no build
// step ties client and server together). Used to validate the two
// status-change endpoints below; the generic handleUpdate() path is left
// unvalidated on purpose - see handleSetLeadStatus/handleSetApplicationStatus.
export const LEAD_STATUS = ["New", "Reviewing", "Applied", "Not a fit"];
export const APP_STATUS = [
  "Applied", "Recruiter Screen", "Tech Screen", "Onsite / Loop",
  "Offer", "Rejected", "Withdrawn",
];

// Which applications column holds the date an application first reached a
// given pipeline stage - mirrors page.html's STAGE_DATE_FIELDS. "Applied"
// isn't here; it already has dateApplied.
export const STAGE_DATE_MAP = {
  "Recruiter Screen": "dateRecruiterScreen",
  "Tech Screen": "dateTechScreen",
  "Onsite / Loop": "dateOnsite",
  "Offer": "dateOffer",
  "Rejected": "dateRejected",
  "Withdrawn": "dateWithdrawn",
};

// Settings held in `meta` that the client renders off. Every one of these is
// optional in the DB - DEFAULT_SETTINGS below is what a deployment that has
// never posted config falls back to, which is also what keeps a fresh
// install's page readable before setup has run.
export const SETTING_KEYS = [
  "display_title", "overview_label", "applications_label", "stale_run_hours",
];

export const DEFAULT_SETTINGS = {
  display_title: "Job Search Tracker",
  // The two tabs that aren't tracks. They're rows in neither `tracks` nor
  // `search_runs` (nothing runs on a schedule to fill them), but their
  // labels still come from config rather than being frozen into the client,
  // so the whole tab bar is built from one data-driven list - see
  // buildTabs() in ../../client/public/index.html.
  overview_label: "Overview",
  applications_label: "Applications",
  // How long a track's last run can be before the client flags it as stale.
  // 36h rather than 24h so a daily search that slips a few hours (a laptop
  // asleep at 08:00, a long run) doesn't cry wolf every morning.
  stale_run_hours: 36,
  priority_locations: [],
};

// Reads the per-deployment config (see migrations/0001_schema.sql):
// the tracks a track tab exists for, plus display settings. This is what
// lets one Worker deployment serve any installer's tracks/branding/priority
// locations without editing the client - the page fetches this (bundled into
// /api/data) and renders off it instead of a baked-in TRACKS object.
//
// Each track carries its own `last_run` (see migrations/0001_schema.sql)
// nested on it rather than arriving as a separate top-level runs[] the
// client would have to re-join by key: the
// table is 1:1 with `tracks` by construction, and every consumer wants them
// together. LEFT JOIN, not JOIN - a track whose search_runs row somehow went
// missing must still render a tab (as "never ran"), never vanish from the UI.
export async function getTracksAndSettings(env) {
  const [tracksRes, settingsRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.key, t.label, t.full_description, t.sort_order,
              r.last_run_at, r.last_run_on, r.status AS last_run_status,
              r.leads_added, r.screened_added, r.delisted, r.note
       FROM tracks t LEFT JOIN search_runs r ON r.track_key = t.key
       ORDER BY t.sort_order, t.key`
    ).all(),
    env.DB.prepare(
      `SELECT key, value FROM meta WHERE key IN (${["priority_locations", ...SETTING_KEYS]
        .map(() => "?")
        .join(", ")})`
    ).bind("priority_locations", ...SETTING_KEYS).all(),
  ]);

  const settings = { ...DEFAULT_SETTINGS };
  for (const row of settingsRows.results) {
    if (row.key === "priority_locations") {
      try {
        settings.priority_locations = JSON.parse(row.value);
      } catch {
        settings.priority_locations = [];
      }
    } else if (row.key === "stale_run_hours") {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) settings.stale_run_hours = n;
    } else {
      settings[row.key] = row.value;
    }
  }

  const tracks = tracksRes.results.map((row) => ({
    key: row.key,
    label: row.label,
    full_description: row.full_description,
    sort_order: row.sort_order,
    last_run: {
      at: row.last_run_at || "",
      on: row.last_run_on || "",
      status: row.last_run_status || "",
      leads_added: row.leads_added || 0,
      screened_added: row.screened_added || 0,
      delisted: row.delisted || 0,
      note: row.note || "",
    },
  }));

  return { tracks, settings };
}

// Records that one track's scheduled search finished - see
// migrations/0001_schema.sql for why this is an explicit call rather than
// something inferred from /api/leads. Called unconditionally at the end
// of every run, including runs that found nothing, since "found nothing" is
// exactly the case the tab can't otherwise distinguish from "didn't run".
//
// Rejects a `search` with no matching track instead of upserting it: an
// unknown key here means the run's track key and the configured tracks have
// drifted apart (a typo in a scheduled-task prompt, or a track renamed in
// config without updating the prompt), and that lead-losing misconfiguration
// is worth surfacing loudly in the run's own output. Silently accepting it
// would create an orphan row that no tab ever displays - the failure mode
// this whole table exists to prevent.
export async function handleRecordRun(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const key = typeof body.search === "string" ? body.search : "";
  if (!key) return json({ error: "missing search (track key)" }, 400);

  const track = await env.DB.prepare("SELECT key FROM tracks WHERE key = ?").bind(key).first();
  if (!track) return json({ error: `unknown track "${key}" - not in the configured tracks` }, 404);

  const now = new Date();
  // `at` is an instant the server can trust; a caller-supplied one is only
  // honoured if it parses, so a malformed clientside date can't poison the
  // staleness math into reading "ran in 2087" and never warning again.
  let at = now.toISOString();
  if (typeof body.at === "string" && body.at && !isNaN(Date.parse(body.at))) {
    at = new Date(body.at).toISOString();
  }
  // `on` is the caller's *local* date - the worker can't derive it (see the
  // note in migrations/0001_schema.sql). Falls back to the UTC date, which is right for
  // any run scheduled outside the hours where the two disagree.
  const on = typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on)
    ? body.on
    : at.slice(0, 10);

  const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  const status = body.status === "error" ? "error" : "ok";

  await env.DB.prepare(
    `INSERT INTO search_runs
       (track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_key) DO UPDATE SET
       last_run_at = excluded.last_run_at, last_run_on = excluded.last_run_on,
       status = excluded.status, leads_added = excluded.leads_added,
       screened_added = excluded.screened_added, delisted = excluded.delisted,
       note = excluded.note`
  )
    .bind(
      key, at, on, status,
      count(body.leadsAdded), count(body.screenedAdded), count(body.delisted),
      typeof body.note === "string" ? body.note.slice(0, 500) : ""
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM search_runs WHERE track_key = ?").bind(key).first();
  return json({ ok: true, run: row });
}

export async function handleGetConfig(env) {
  return json(await getTracksAndSettings(env));
}

// Replaces the whole track list (setup writes the complete desired set at
// once, rather than incrementally patching rows) and/or updates individual
// settings. Existing leads/applications keep their `search` value even if
// its track is later removed here - they just stop having a tab, they're
// never deleted.
export async function handleSetConfig(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (Array.isArray(body.tracks)) {
    const valid = body.tracks.filter((t) => t && typeof t.key === "string" && t.key);
    if (valid.length === 0) return json({ error: "tracks must be a non-empty array of {key, ...}" }, 400);
    const stmt = env.DB.prepare(
      `INSERT INTO tracks (key, label, full_description, sort_order) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label,
         full_description = excluded.full_description, sort_order = excluded.sort_order`
    );
    // search_runs is kept 1:1 with tracks in the same transaction as the
    // track write itself (see migrations/0001_schema.sql): a new
    // track gets an empty "never ran" row so it has one from the moment its
    // tab exists, and a removed track's run row goes with it. INSERT OR
    // IGNORE, not a plain INSERT - re-posting an unchanged track list is the
    // normal case (setup writes the whole list every time) and must not wipe
    // the run history of tracks that were already there.
    const runStmt = env.DB.prepare("INSERT OR IGNORE INTO search_runs (track_key) VALUES (?)");
    const placeholders = valid.map(() => "?").join(", ");
    const keys = valid.map((t) => t.key);
    const batch = [
      env.DB.prepare(`DELETE FROM tracks WHERE key NOT IN (${placeholders})`).bind(...keys),
      env.DB.prepare(`DELETE FROM search_runs WHERE track_key NOT IN (${placeholders})`).bind(...keys),
      ...valid.map((t, i) =>
        stmt.bind(t.key, t.label || t.key, t.full_description || "", Number.isInteger(t.sort_order) ? t.sort_order : i)
      ),
      ...keys.map((k) => runStmt.bind(k)),
    ];
    await env.DB.batch(batch);
  }

  // display_title, overview_label, applications_label - the three names the
  // tab bar and header render from (see DEFAULT_SETTINGS). Empty strings are
  // ignored rather than stored, so clearing one falls back to the default
  // instead of producing a blank tab.
  const textSettings = SETTING_KEYS.filter((k) => k !== "stale_run_hours");
  for (const key of textSettings) {
    if (typeof body[key] === "string" && body[key]) {
      await env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, body[key]).run();
    }
  }

  if (body.stale_run_hours != null) {
    const n = Number(body.stale_run_hours);
    if (!Number.isFinite(n) || n <= 0) return json({ error: "stale_run_hours must be a positive number" }, 400);
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('stale_run_hours', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(String(n)).run();
  }

  if (Array.isArray(body.priority_locations)) {
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES ('priority_locations', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(JSON.stringify(body.priority_locations)).run();
  }

  return json(await getTracksAndSettings(env));
}

export async function handleAddLeads(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.leads) ? body.leads : [];
  if (incoming.length === 0) return json({ error: "no leads provided" }, 400);

  const t = today();
  // team/setup/comp are the fields a job posting can actually state (org,
  // remote/hybrid/onsite, a posted salary range); the rest of EXTRA_FIELDS
  // (referral, resume, lastContact, nextAction*, link) are personal/workflow
  // facts the search has no way to know, so they're accepted here (in case a
  // future caller has them) but the scheduled searches never send them -
  // they default to '' and stay for the user to fill in from Details.
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO leads
       (search, found, company, title, location, url, verified, fit, status, notes, ${EXTRA_FIELDS.join(", ")})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', '', ${EXTRA_FIELDS.map(() => "?").join(", ")})`
  );

  const batch = [];
  for (const lead of incoming) {
    if (!lead.search || !lead.url || !lead.company || !lead.title) continue;
    batch.push(
      stmt.bind(
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
  }
  if (batch.length === 0) return json({ error: "no valid leads in payload" }, 400);

  const results = await env.DB.batch(batch);
  const added = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  if (added > 0) await touchUpdated(env);

  return json({ added });
}

// Records postings the search looked at and decided NOT to add as a lead
// (dead-on-arrival, outside the US, wrong level/role-type, duplicate) - see
// migrations/0001_schema.sql. Same INSERT-OR-IGNORE-on-(search,
// url) shape as handleAddLeads above, but no touchUpdated() call: screened
// items don't show up on the tracker page, so they shouldn't bump its
// "last updated" banner.
export async function handleAddScreened(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.screened) ? body.screened : [];
  if (incoming.length === 0) return json({ error: "no screened items provided" }, 400);

  const t = today();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO screened (search, url, company, title, location, reason, date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = [];
  for (const item of incoming) {
    if (!item.search || !item.url) continue;
    batch.push(
      stmt.bind(
        item.search,
        item.url,
        item.company || "",
        item.title || "",
        item.location || "",
        item.reason || "",
        item.date || t
      )
    );
  }
  if (batch.length === 0) return json({ error: "no valid screened items in payload" }, 400);

  const results = await env.DB.batch(batch);
  const added = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
  return json({ added });
}

export async function handleUpdate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (body.type === "lead") {
    // delistedOn is set/cleared by the scheduled searches (see
    // migrations/0001_schema.sql) - kept separate from `status`
    // so it never overwrites the installer's own application-progress field.
    const fields = ["status", "notes", "delistedOn", ...EXTRA_FIELDS];
    const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
    const values = fields.map((f) => (typeof body[f] === "string" ? body[f] : null));
    const result = await env.DB.prepare(`UPDATE leads SET ${setClause} WHERE id = ?`)
      .bind(...values, body.id)
      .run();
    if (result.meta.changes === 0) return json({ error: "lead not found" }, 404);
    await touchUpdated(env);
    const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(body.id).first();
    return json({ ok: true, lead });
  }

  if (body.type === "application") {
    const fields = ["company", "title", "dateApplied", "status", "notes", "leadId", ...EXTRA_FIELDS, ...APP_STAGE_DATE_FIELDS];
    if (body.id) {
      const setClause = fields.map((f) => `${f} = COALESCE(?, ${f})`).join(", ");
      const values = fields.map((f) => (typeof body[f] === "string" ? body[f] : null));
      const result = await env.DB.prepare(`UPDATE applications SET ${setClause} WHERE id = ?`)
        .bind(...values, body.id)
        .run();
      if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
      await touchUpdated(env);
      const app = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(body.id).first();
      return json({ ok: true, application: app });
    } else {
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((f) => {
        if (f === "dateApplied") return body.dateApplied || today();
        if (f === "status") return body.status || "Applied";
        return body[f] || "";
      });
      const result = await env.DB.prepare(
        `INSERT INTO applications (${fields.join(", ")}) VALUES (${placeholders})`
      )
        .bind(...values)
        .run();
      await touchUpdated(env);
      const app = await env.DB
        .prepare("SELECT * FROM applications WHERE id = ?")
        .bind(result.meta.last_row_id)
        .first();
      return json({ ok: true, application: app });
    }
  }

  return json({ error: "unknown update type" }, 400);
}

// Atomically moves a lead to "Applied" and creates its application row -
// replaces the client's old two-sequential-POST approach (set status, then
// a separate call to create the application), which could leave a lead
// marked Applied with no application if the second call never landed.
// D1's batch() runs as one real transaction: if either statement fails,
// both roll back.
//
// The duplicate-application guard here is a read-then-conditionally-write
// within one request, not a schema-enforced constraint - it doesn't
// protect against two genuinely concurrent requests for the same lead
// (e.g. two devices). Still a strict improvement over the previous
// client-side guard, which trusted stale local state and never
// re-checked the server at all.
export async function handleSetLeadStatus(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!LEAD_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }

  const [lead, existingApp] = await Promise.all([
    env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first(),
    env.DB.prepare("SELECT * FROM applications WHERE leadId = ? LIMIT 1").bind(String(id)).first(),
  ]);
  if (!lead) return json({ error: "lead not found" }, 404);

  const batch = [
    env.DB.prepare("UPDATE leads SET status = ? WHERE id = ?").bind(body.status, id),
  ];
  const willCreateApp = body.status === "Applied" && !existingApp;
  if (willCreateApp) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO applications
           (leadId, company, title, dateApplied, status, notes, link, referral, comp, team, setup)
         VALUES (?, ?, ?, ?, 'Applied', ?, ?, ?, ?, ?, ?)`
      ).bind(
        String(id), lead.company, lead.title, today(), lead.notes || "", lead.url || "",
        lead.referral || "", lead.comp || "", lead.team || "", lead.setup || ""
      )
    );
  }
  const results = await env.DB.batch(batch);
  await touchUpdated(env);

  const updatedLead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  let application = existingApp || null;
  if (willCreateApp) {
    application = await env.DB
      .prepare("SELECT * FROM applications WHERE id = ?")
      .bind(results[1].meta.last_row_id)
      .first();
  }
  return json({ lead: updatedLead, application });
}

// Validates status and, the first time an application reaches a stage
// with a Stage history column (STAGE_DATE_MAP), stamps it with today's
// date in the same statement - but only if that column is still empty,
// so it never overwrites a date the user corrected or backfilled by hand
// (that still goes through the generic handleUpdate() path below).
export async function handleSetApplicationStatus(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!APP_STATUS.includes(body.status)) {
    return json({ error: "invalid status" }, 400);
  }

  const stageCol = STAGE_DATE_MAP[body.status];
  const result = stageCol
    ? await env.DB.prepare(
        `UPDATE applications SET status = ?, ${stageCol} = CASE WHEN ${stageCol} = '' THEN ? ELSE ${stageCol} END WHERE id = ?`
      ).bind(body.status, today(), id).run()
    : await env.DB.prepare("UPDATE applications SET status = ? WHERE id = ?").bind(body.status, id).run();

  if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
  await touchUpdated(env);
  const application = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first();
  return json({ application });
}

export async function handleDeleteApplication(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.id) return json({ error: "missing id" }, 400);
  const result = await env.DB.prepare("DELETE FROM applications WHERE id = ?").bind(body.id).run();
  if (result.meta.changes === 0) return json({ error: "application not found" }, 404);
  await touchUpdated(env);
  return json({ ok: true });
}
