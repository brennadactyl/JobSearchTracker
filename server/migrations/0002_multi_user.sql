-- Multi-user: every row gains an owner, and login stops being one shared secret.
--
-- Until now this was a single-tenant deployment by construction - one
-- API_TOKEN worker secret whose holder could read and write everything, and
-- one set of tracks/meta rows that the client rendered as *the* page. Nothing
-- carried an owner because nothing needed to. Supporting a second person's job
-- search in the same database means every table needs a user_id, and three of
-- them need their uniqueness rules to become per-user rather than global.
--
-- Why this is a table rebuild and not a pile of ALTER TABLEs: SQLite can add a
-- column in place, but it cannot change a PRIMARY KEY or a UNIQUE constraint.
-- leads/screened need UNIQUE(search, url) -> UNIQUE(user_id, search, url) so
-- two people can independently track the same posting; tracks/search_runs/meta
-- need their primary key to gain user_id so two people can both have a track
-- called "SWE" and their own display_title. Each of those five is therefore
-- create-new / copy / drop / rename. `applications` only needs the column, so
-- it gets a plain ALTER. No foreign keys are declared anywhere in this schema
-- (see 0001), so no PRAGMA foreign_keys dance is required around the drops.
--
-- The new tables below are written in 0001's column order with user_id
-- appended, so a fresh database and a migrated one end up identical.

-- Login identity. The name is for display and for the login form; it is never
-- what other tables reference - that is always the GUID id, so renaming a
-- person doesn't rewrite their data.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,        -- GUID, from crypto.randomUUID()
  -- COLLATE NOCASE so "Brenna" and "brenna" are one account, not two. Someone
  -- typing their own name into a login form will not reproduce their own
  -- capitalisation reliably, and the failure without this is nasty: a
  -- password reset for a name that differs by one letter silently creates a
  -- *second*, empty account, and the person signs in to an empty tracker
  -- while all their data sits behind the original. (ASCII-only folding, which
  -- is all SQLite offers - fine for names typed into a sign-in box.)
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- login + display only
  -- PBKDF2-SHA256 derived bits and salt, both base64. An empty hash means
  -- login is disabled for this user: it's the state the backfill row below
  -- starts in, since SQL can't run PBKDF2 - POST /api/users sets the real one.
  password_hash TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL DEFAULT '',
  iterations    INTEGER NOT NULL DEFAULT 100000,
  created_at    TEXT NOT NULL DEFAULT ''
);

-- One row per issued bearer token. Replaces the single API_TOKEN secret: the
-- token is no longer a constant compiled into the deployment's config, it's a
-- row that can be handed out and taken away per credential.
--
-- No expiry, deliberately - the token it replaces never expired either, and a
-- headless search that had to re-authenticate on a schedule would be a new
-- failure mode for no gain. Logout is a row delete.
--
-- `label` is what makes that revocation usable in practice: the scheduled
-- search holds one long-lived session, each browser holds its own, and either
-- can be killed without disturbing the other.
CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the bearer token, base64 - not the token. The token is 32
  -- random bytes and needs no stretching, but storing it as-is would make a
  -- `d1 export`, a backup, or an admin's audit query hand over working
  -- credentials for every signed-in device. See src/auth.js's hashToken.
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL DEFAULT ''  -- 'browser' | 'scheduled-search' | 'legacy scheduled search'
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- The owner of everything that already exists.
--
-- Conditional on there actually being data, for the same reason 0001 seeds
-- nothing: this file also runs against brand-new databases that installers
-- create from a fresh fork, and handing one of those a pre-made account would
-- be baking one deployment's specifics into everyone's schema. A database with
-- rows in it has exactly one owner by definition (whoever has been using it);
-- an empty one gets no user and is provisioned entirely through POST /api/users.
--
-- Named 'owner' rather than any real person, for the same reason. Rename it in
-- the same step that sets its password - see server/README.md's migration
-- notes; the id, which is what every row below points at, doesn't change.
INSERT INTO users (id, name, password_hash, password_salt, iterations, created_at)
SELECT 'ab266b6c-00cc-45d1-92ac-cdad412c1558', 'owner', '', '', 100000, date('now')
WHERE EXISTS (SELECT 1 FROM leads)
   OR EXISTS (SELECT 1 FROM applications)
   OR EXISTS (SELECT 1 FROM screened)
   OR EXISTS (SELECT 1 FROM search_runs)
   OR EXISTS (SELECT 1 FROM meta)
   OR EXISTS (SELECT 1 FROM tracks);

-- ---------------------------------------------------------------- leads --

CREATE TABLE leads_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  search TEXT NOT NULL,
  found TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  verified TEXT NOT NULL,
  fit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
  delistedOn TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  setup TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  lastContact TEXT NOT NULL DEFAULT '',
  nextAction TEXT NOT NULL DEFAULT '',
  nextActionDate TEXT NOT NULL DEFAULT '',
  resume TEXT NOT NULL DEFAULT '',
  referral TEXT NOT NULL DEFAULT '',
  comp TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, search, url)
);
INSERT INTO leads_new
  (id, user_id, search, found, company, title, location, url, verified, fit, status, notes,
   delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp)
SELECT id, 'ab266b6c-00cc-45d1-92ac-cdad412c1558', search, found, company, title, location, url, verified, fit, status, notes,
   delistedOn, team, setup, source, link, lastContact, nextAction, nextActionDate, resume, referral, comp
FROM leads;
DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;
CREATE INDEX idx_leads_user ON leads(user_id);

-- --------------------------------------------------------- applications --

-- The only table whose constraints don't change - no UNIQUE, no natural key -
-- so a plain column add is enough.
ALTER TABLE applications ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE applications SET user_id = 'ab266b6c-00cc-45d1-92ac-cdad412c1558';
CREATE INDEX idx_applications_user ON applications(user_id);

-- ------------------------------------------------------------- screened --

CREATE TABLE screened_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  search TEXT NOT NULL,
  url TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  UNIQUE(user_id, search, url)
);
INSERT INTO screened_new (id, user_id, search, url, company, title, location, reason, date)
SELECT id, 'ab266b6c-00cc-45d1-92ac-cdad412c1558', search, url, company, title, location, reason, date
FROM screened;
DROP TABLE screened;
ALTER TABLE screened_new RENAME TO screened;
CREATE INDEX idx_screened_user ON screened(user_id);

-- --------------------------------------------------------------- tracks --

-- Gains the per-track half of the search config alongside user_id. Until now a
-- track was only ever a tab on the webpage, and the search that filled that tab
-- was defined by a hand-maintained prompt file in the private data folder on
-- one machine. These columns are that definition, moved into the database so
-- the worker can compose the prompt (see src/prompt.js) for any user from
-- anywhere.
--
-- Most of them hold prose, not keywords, and that is deliberate. The live
-- prompt files had drifted from the template that generated them, and the
-- drift was load-bearing: the resume line names a fallback file the machine
-- genuinely depends on, one track's step 3 carries a sentence that widens the
-- company search, the doc filenames predate the current naming convention.
-- Storing a keyword and regenerating the sentence loses all of that. Only the
-- fields the *app* reads (key, label, sort_order, schedule_time,
-- target_companies) are structured; the rest is text only the model reads, kept
-- verbatim. See docs/multi-user-plan.md.
CREATE TABLE tracks_new (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,                  -- e.g. "SWE"; matches leads.search
  label TEXT NOT NULL,                -- the tab label, e.g. "Engineering"
  full_description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Search config, read only by src/prompt.js.
  role_search_line TEXT NOT NULL DEFAULT '',   -- the titles/seniority to search for
  target_companies TEXT NOT NULL DEFAULT '',   -- JSON array of company names
  search_note TEXT NOT NULL DEFAULT '',        -- free-text addendum to the company list
  resume_line TEXT NOT NULL DEFAULT '',        -- the whole step-2 instruction: which resume to read, and how this track frames it
  fit_clause TEXT NOT NULL DEFAULT '',         -- track-specific fit requirement, or ''
  fit_disqualifier TEXT NOT NULL DEFAULT '',   -- its mirror in the disqualified list, or ''
  -- A whole extra screening step, for a track where fit is the hard part
  -- rather than a clause (a pivot into a role type the resume doesn't already
  -- prove). Set, it runs as its own step before the capture step - which
  -- renumbers 6b to 6c, references to it included. Empty, there's no step.
  fit_filter_step TEXT NOT NULL DEFAULT '',
  -- An extra clause for step 9, where a track needs one field always filled in.
  leads_note TEXT NOT NULL DEFAULT '',
  doc_file TEXT NOT NULL DEFAULT '',           -- path to the per-track notes doc, '' = derive from key
  doc_summary TEXT NOT NULL DEFAULT '',        -- what that doc contains
  doc_update_line TEXT NOT NULL DEFAULT '',    -- the whole step-8b instruction, when the default won't do
  intro_note TEXT NOT NULL DEFAULT '',         -- sibling-tracks note, or ''
  report_line TEXT NOT NULL DEFAULT '',        -- overrides the default step 10 when set
  screened_examples TEXT NOT NULL DEFAULT '',  -- track-specific step-9b reason examples
  schedule_time TEXT NOT NULL DEFAULT '',      -- HH:mm local, read by setup-scheduler.ps1
  PRIMARY KEY (user_id, key)
);
INSERT INTO tracks_new (user_id, key, label, full_description, sort_order)
SELECT 'ab266b6c-00cc-45d1-92ac-cdad412c1558', key, label, full_description, sort_order FROM tracks;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;

-- ---------------------------------------------------------- search_runs --

CREATE TABLE search_runs_new (
  user_id TEXT NOT NULL,
  track_key TEXT NOT NULL,
  last_run_at TEXT NOT NULL DEFAULT '',
  last_run_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  leads_added INTEGER NOT NULL DEFAULT 0,
  screened_added INTEGER NOT NULL DEFAULT 0,
  delisted INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, track_key)
);
INSERT INTO search_runs_new
  (user_id, track_key, last_run_at, last_run_on, status, leads_added, screened_added, delisted, note)
SELECT 'ab266b6c-00cc-45d1-92ac-cdad412c1558', track_key, last_run_at, last_run_on, status,
       leads_added, screened_added, delisted, note
FROM search_runs;
DROP TABLE search_runs;
ALTER TABLE search_runs_new RENAME TO search_runs;

-- ----------------------------------------------------------------- meta --

-- Now per-user, which is the point: `updated`, `display_title`,
-- `priority_locations` and the rest were global settings describing one
-- person's page. Two new keys join them, holding the per-user half of the
-- search config (the per-track half is in `tracks` above): geo_scope_line,
-- scope_clause, scope_disqualifier, location_guidance, footer_note, pronouns.
-- Like the track columns, they store prose verbatim rather than keywords the
-- worker would re-synthesize a sentence from.
CREATE TABLE meta_new (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO meta_new (user_id, key, value)
SELECT 'ab266b6c-00cc-45d1-92ac-cdad412c1558', key, value FROM meta;
DROP TABLE meta;
ALTER TABLE meta_new RENAME TO meta;
