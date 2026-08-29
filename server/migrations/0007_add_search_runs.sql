-- One row per track (i.e. per tab): when that track's scheduled search last
-- ran, and what it did. Answers the question the rest of the schema can't:
-- "did today's search actually run?"
--
-- Nothing already in the DB could answer that. A run that finds nothing
-- writes nothing - no leads, no screened rows, no `meta.updated` bump - so a
-- search that quietly stopped firing (expired OAuth token, Task Scheduler
-- task disabled, machine asleep at the scheduled time) looks exactly like a
-- genuine zero-result day. Both show an unchanged tab. That ambiguity is the
-- whole reason this table exists, which is why the run is recorded by its
-- own POST /api/runs call the search makes unconditionally at the end of
-- every run, rather than being inferred as a side effect of /api/leads or
-- /api/screened - inferring it would only ever record the runs that found
-- something, exactly the runs that never needed recording.
--
-- Deliberately last-run-only, not an append-only run history: the UI
-- question is "is each search still running?", which only needs the most
-- recent answer, and a single row per track keeps this 1:1 with `tracks` (a
-- history table would grow unboundedly for a display that only ever reads
-- the newest row). handleSetConfig in ../src/api.js maintains that 1:1 -
-- adding a track adds its row here, removing one removes it.
--
-- Not seeded with any run data: no existing column records when past runs
-- happened, and inventing a timestamp would be worse than admitting we don't
-- know. Tracks created before this migration therefore read as "No run
-- recorded yet" until their next scheduled run, which self-corrects within a
-- day.
CREATE TABLE IF NOT EXISTS search_runs (
  track_key TEXT PRIMARY KEY,     -- matches tracks.key / leads.search
  last_run_at TEXT NOT NULL DEFAULT '',   -- ISO 8601 UTC instant, e.g. "2026-08-29T15:00:02Z". Empty = never recorded.
  last_run_on TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD as the *caller's* local date - see below
  status TEXT NOT NULL DEFAULT '',        -- 'ok' | 'error' (free text tolerated; the client only styles these two)
  leads_added INTEGER NOT NULL DEFAULT 0,
  screened_added INTEGER NOT NULL DEFAULT 0,
  delisted INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''           -- short human summary, e.g. "no new postings" or an error line
);

-- Why both last_run_at and last_run_on: the worker only knows UTC, but "did
-- it run this morning?" is a question about the installer's local day. A
-- search running at 08:00 Pacific is already the *next* UTC date, so deriving
-- the local day from last_run_at would show tomorrow's date on every run.
-- last_run_on is whatever local date the caller sends (the scheduled run
-- knows its own timezone); last_run_at stays the unambiguous instant used for
-- "how long ago" staleness math.

-- Backfill a row for every track that already exists, so the invariant
-- "one row per tab" holds from the moment this migration lands rather than
-- only for tracks created afterward.
-- INSERT OR IGNORE rather than ON CONFLICT DO NOTHING: SQLite can't parse an
-- upsert clause directly after a SELECT source without a disambiguating
-- WHERE, and OR IGNORE says the same thing without the workaround.
INSERT OR IGNORE INTO search_runs (track_key) SELECT key FROM tracks;
