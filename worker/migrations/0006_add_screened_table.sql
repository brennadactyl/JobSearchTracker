-- A record of postings the daily search looked at and deliberately did NOT
-- add as a lead - dead-on-arrival at verification time, outside the US,
-- wrong seniority/role-type, or a duplicate of an existing lead. This is
-- distinct from `leads.delistedOn` (migrations/0004), which tracks a lead
-- that WAS added and later confirmed taken down - `screened` postings never
-- became a lead in the first place.
--
-- Previously this history lived as free-text bullet lists inside each
-- track's private baseline doc (the "outside the US" / "Removed / went
-- dead" / exclusion-notes sections) - moved here for the same reason the
-- "Postings Found" table moved to `leads`: one atomic, race-free, queryable
-- copy instead of an ever-growing doc a headless run has to read/rewrite in
-- full every time. Entries predating this migration stay frozen in the doc
-- as historical record rather than being backfilled - the doc's free text
-- doesn't map cleanly enough to these columns to convert automatically
-- without risking silently misrepresenting the original reasoning.
--
-- No delete/un-screen endpoint (mirrors `leads`, which are re-statused, not
-- deleted): a screening decision made once is expected to stay true (a
-- posting's location or seniority doesn't change), so there's currently no
-- flow that needs to reverse one.
CREATE TABLE IF NOT EXISTS screened (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search TEXT NOT NULL,        -- track key, e.g. "SWE" | "TPM" | "CPM"
  url TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',   -- free text, e.g. "outside the US: London, UK", "SDE II is below Senior", "duplicate of req 7829580003"
  date TEXT NOT NULL,          -- date screened, YYYY-MM-DD
  UNIQUE(search, url)          -- same INSERT-OR-IGNORE dedup pattern as leads
);
