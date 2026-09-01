-- Which companies a search has covered, and when.
--
-- The company list is longer than one run can verify properly, so a run covers
-- a bounded slice of it and rotates. That needs memory: without it every run
-- starts at the top of the list and the tail never gets searched at all.
--
-- This first lived as a Markdown table in each person's baseline doc, which
-- was the wrong home for the same reason posting data isn't kept there (see
-- 0001_schema.sql): it's per-run mutable state, rewritten nightly by a model,
-- where a botched edit silently loses the rotation's memory and a merge of two
-- runs' edits is nobody's job. The doc holds knowledge that has no DB
-- equivalent; this has one.
--
-- Keyed like leads and screened - (user_id, search, company) - so two people
-- sweep independently, and one person's engineering and product searches keep
-- separate schedules for a company both of them list.
CREATE TABLE IF NOT EXISTS company_sweeps (
  user_id TEXT NOT NULL,
  search TEXT NOT NULL,               -- track key, matches tracks.key
  company TEXT NOT NULL,
  -- YYYY-MM-DD the run last *attempted* this company, '' for never. Attempted,
  -- not succeeded: a company skipped because its domain is blocked still gets
  -- stamped, or the rotation retries it every single run forever.
  last_swept TEXT NOT NULL DEFAULT '',
  -- What kind of JSON board it has, once one is confirmed ('greenhouse',
  -- 'ashby', 'workday cxs', ...). Empty means none known. This is what sorts a
  -- company into the cheap tier: one fetch that is both discovery and
  -- verification, worth doing every run rather than rotating.
  board TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, search, company)
);
