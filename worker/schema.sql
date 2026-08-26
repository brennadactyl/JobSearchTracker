-- Job Search Tracker - D1 schema
-- Apply with: wrangler d1 execute job-search-tracker-db --remote --file=./schema.sql

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
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
