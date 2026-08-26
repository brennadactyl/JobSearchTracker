-- Baseline migration: the schema as it stood when the migrations/ workflow
-- was introduced. CREATE TABLE IF NOT EXISTS makes this safe to run against
-- a brand-new database (creates everything at once). CORRECTION: it does
-- NOT retroactively add these columns to an already-existing table with an
-- older shape - that turned out to be false when this comment originally
-- claimed it (see 0002_add_extra_fields.sql, which had to add for real the
-- columns this file's CREATE TABLE IF NOT EXISTS silently skipped against
-- the live table created by the original hand-run schema.sql).
--
-- Going forward, schema changes are new numbered files in this folder
-- (`wrangler d1 migrations create job-search-tracker-db <name>`), using real
-- ALTER TABLE statements when the table already exists - not edits to this
-- one.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search TEXT NOT NULL,        -- "SWE" | "TPM" | "CPM"
  found TEXT NOT NULL,         -- date first found, YYYY-MM-DD
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  verified TEXT NOT NULL,      -- date last verified live, YYYY-MM-DD
  fit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
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
  UNIQUE(search, url)          -- lets adding leads use INSERT OR IGNORE for
                                -- atomic, race-free de-duplication
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leadId TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  dateApplied TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Applied',
  notes TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  setup TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  lastContact TEXT NOT NULL DEFAULT '',
  nextAction TEXT NOT NULL DEFAULT '',
  nextActionDate TEXT NOT NULL DEFAULT '',
  resume TEXT NOT NULL DEFAULT '',
  referral TEXT NOT NULL DEFAULT '',
  comp TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
